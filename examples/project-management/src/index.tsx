import { render } from "solid-js/web";

import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing application root");

render(() => <App />, root);
