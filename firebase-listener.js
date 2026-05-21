const { initializeApp, getApps } = require('firebase/compat/app');
require('firebase/compat/firestore');

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

function getDb() {
  if (!db) {
    const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
    db = app.firestore();
  }
  return db;
}

/**
 * Start listening to pending print jobs in Firestore.
 * @param {{ onStatus: Function, onJob: Function }} callbacks
 */
function startListening({ onStatus, onJob }) {
  try {
    const firestore = getDb();
    onStatus('connecting');

    const q = firestore
      .collection('printJobs')
      .where('status', '==', 'pending')
      .orderBy('createdAt', 'asc');

    unsubscribe = q.onSnapshot(
      async (snap) => {
        onStatus('connected');

        for (const change of snap.docChanges()) {
          if (change.type !== 'added') continue;

          const job = { id: change.doc.id, ...change.doc.data() };

          // Mark as printing to prevent other agents picking it up
          await change.doc.ref.update({ status: 'printing', processingAt: new Date() });

          const result = await onJob(job);

          await change.doc.ref.update({
            status: result.success ? 'done' : 'error',
            processedAt: new Date(),
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

module.exports = { startListening, stopListening };
