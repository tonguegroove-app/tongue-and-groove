import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { hydrate } from "./storage.js";
import "./fonts.css";

registerSW({ immediate: true });

// App.jsx reads saved state synchronously at module scope (`const saved =
// loadState()`), so it must not be evaluated until the durable mirror has been
// restored into localStorage — hence the dynamic import rather than a static
// one at the top of this file. On web hydrate() resolves on the first tick and
// this is the same boot it always was; on native it is what makes a patient's
// progress survive an iOS storage eviction.
hydrate()
  .catch(() => {})
  .then(() => import("./App.jsx"))
  .then(({ default: App }) => {
    createRoot(document.getElementById("root")).render(<App />);
  });
