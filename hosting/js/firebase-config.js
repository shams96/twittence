// Firebase client config — safe to expose publicly (restricted by Firebase security rules, not secrecy).
export const firebaseConfig = {
  apiKey: "AIzaSyC-_gj9CW0MlwNy6c8uXdn9XMjrCTsGpJI",
  authDomain: "sound-octagon-444117-m9.firebaseapp.com",
  projectId: "sound-octagon-444117-m9",
  storageBucket: "sound-octagon-444117-m9.firebasestorage.app",
  messagingSenderId: "1087418946550",
  appId: "1:1087418946550:web:62bbfe864df3ba77c1add7",
};

// Always same-origin: Firebase Hosting rewrites /api/** to the Cloud Function in production,
// and functions/index.js serves this static hosting/ directory itself when run locally —
// so the API and frontend are never on different ports/origins.
export const API_BASE = "";
