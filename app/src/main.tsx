// Order matters: tokens and app CSS load before any component CSS (imported by Root), so component rules win ties.
import "./brand/tokens.css";
import "./app.css";
import { createRoot } from "react-dom/client";
import { Root } from "./Root";

createRoot(document.getElementById("root")!).render(<Root />);
