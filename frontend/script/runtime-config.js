(function configureCodeTracker(globalScope) {
  "use strict";

  // Edit deployment URLs here. All pages load this file before their clients.
  // Keep secrets (Gemini keys, JWT keys, OAuth secrets) on the backend only.
  const defaults = {
    apiBaseUrl: "https://codetracker-production-afd9.up.railway.app/api",
    // The former analyzer deployment returns Railway's "Application not found".
    // Set this to the replacement analyzer service's HTTPS origin when restored.
    analyzerBaseUrl: "https://anayzer-production-50e0.up.railway.app",
    features: {
      // Deploy the persistent-history backend and Supabase SQL migration first.
      // Account theme sync is still optional; chat history now uses the backend.
      accountTheme: false,
      remoteChatHistory: true
    }
  };

  const overrides = globalScope.CodeTrackerConfig || {};
  globalScope.CodeTrackerConfig = Object.freeze({
    ...defaults,
    ...overrides,
    features: Object.freeze({ ...defaults.features, ...overrides.features })
  });
})(window);
