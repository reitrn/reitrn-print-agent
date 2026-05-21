const { initializeApp, getApps, getApp } = require('firebase/app');
const {
  getFirestore,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  doc,
  updateDoc,
  setDoc,
  deleteDoc,
  runTransaction,
  Timestamp,
} = require('firebase/firestore');

// ── Firebase config (same project as hub) ─────────────────────────────────────
const firebaseConfig = {
  apiKey:            'AIzaSyC96_lHPTQzvf1H5SeUlwst89dWny9RN3w',
  authDomain:        'studio-4002783127-fd348.firebaseapp.com',
  projectId:         'studio-4002783127-fd348',
  storageBucket:     'studio-4002783127-fd348.firebasestorage.app',
  messagingSenderId: '1077747899416',
  appId:             '1:1077747899416:web:a8f91272dca46f866b376d',
};

let db = null;
let unsubscribe = null;
let heartbeatTimer = null;
let registeredStationName = null;

// ── Station registration ───────────────────────────────────────────────────────
// Each agent registers itself in the `printStations` collection so that
// web/mobile apps can discover available stations and route jobs correctly.

async function registerStation({ name, courierPrinter = '', barcodePrinter = '' }) {
  try {
    const firestore = getDb();

    // If the station was renamed, delete the old document so it doesn't linger
    if (registeredStationName && registeredStationName !== name) {
      try {
        await deleteDoc(doc(firestore, 'printStations', registeredStationName));
        console.log(`[Firebase] Deleted old station "${registeredStationName}"`);
      } catch (e) {
        console.warn('[Firebase] Could not delete old station doc:', e.message);
      }
    }

    registeredStationName = name;
    await setDoc(doc(firestore, 'printStations', name), {
      name,
      status: 'online',
      courierPrinter,
      barcodePrinter,
      lastSeen: Timestamp.now(),
    }, { merge: true });

    // Heartbeat every 30 s to keep lastSeen fresh and status visible
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(async () => {
      try {
        await setDoc(doc(getDb(), 'printStations', name), {
          lastSeen: Timestamp.now(),
          status: 'online',
        }, { merge: true });
      } catch { /* ignore transient errors */ }
    }, 30_000);

    console.log(`[Firebase] Station "${name}" registered`);
  } catch (err) {
    console.error('[Firebase] Station registration failed:', err.message);
  }
}

async function deregisterStation() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (!registeredStationName) return;
  try {
    await setDoc(doc(getDb(), 'printStations', registeredStationName), {
      status: 'offline',
      lastSeen: Timestamp.now(),
    }, { merge: true });
    console.log(`[Firebase] Station "${registeredStationName}" marked offline`);
  } catch { /* best-effort on quit */ }
}

function getDb() {
  if (!db) {
    const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    db = getFirestore(app);
  }
  return db;
}

/**
 * Start listening to pending print jobs in Firestore.
 * @param {{ onStatus: Function, onJob: Function, getAgentName: Function }} callbacks
 *   getAgentName — called each time a job is processed so renames take effect immediately.
 */
function startListening({ onStatus, onJob, getAgentName }) {
  try {
    const firestore = getDb();
    onStatus('connecting');

    const q = query(
      collection(firestore, 'printJobs'),
      where('status', '==', 'pending'),
      orderBy('createdAt', 'asc'),
    );

    unsubscribe = onSnapshot(
      q,
      async (snap) => {
        onStatus('connected');

        for (const change of snap.docChanges()) {
          if (change.type !== 'added') continue;

          const job = { id: change.doc.id, ...change.doc.data() };
          const myName = (getAgentName ? getAgentName() : '') || 'Warehouse PC';

          // ── Station targeting ──────────────────────────────────────────────
          // If the job specifies a target station, only the matching agent
          // should process it. '*' or missing = any agent can handle it.
          const target = job.targetStation;
          if (target && target !== '*' && target !== myName) {
            continue; // Not for this station — another agent will pick it up
          }

          // ── Atomic claim via transaction ───────────────────────────────────
          // Prevents two agents from both seeing 'pending' simultaneously and
          // both printing the same job. Only the first to commit wins.
          const jobRef = doc(firestore, 'printJobs', change.doc.id);
          let claimed = false;
          try {
            await runTransaction(firestore, async (t) => {
              const fresh = await t.get(jobRef);
              if (!fresh.exists() || fresh.data().status !== 'pending') {
                throw new Error('already_claimed');
              }
              t.update(jobRef, {
                status: 'printing',
                claimedBy: myName,
                processingAt: Timestamp.now(),
              });
            });
            claimed = true;
          } catch (err) {
            if (err.message !== 'already_claimed') {
              console.warn('[Firebase] Claim transaction failed:', err.message);
            }
            continue; // Another agent already claimed this job
          }

          if (!claimed) continue;

          const result = await onJob(job);

          await updateDoc(jobRef, {
            status: result.success ? 'done' : 'error',
            processedAt: Timestamp.now(),
            ...(result.error ? { errorMessage: result.error } : {}),
          });
        }
      },
      (err) => {
        console.error('[Firebase] Listener error:', err.message);
        onStatus('error');
        // Retry after 10 seconds
        setTimeout(() => startListening({ onStatus, onJob }), 10_000);
      },
    );

    console.log('[Firebase] Listening for print jobs…');
  } catch (err) {
    console.error('[Firebase] Init error:', err.message);
    onStatus('error');
    setTimeout(() => startListening({ onStatus, onJob }), 10_000);
  }
}

function stopListening() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}

module.exports = { startListening, stopListening, registerStation, deregisterStation };
