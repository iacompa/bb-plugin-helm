// Helm — plugin frontend entry. Compiled by `bb plugin build` into dist/app.js.
// React and @get-bb/plugin-sdk/app are provided by BB at load time.
import "./components/helm/helm.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { HelmApp } from "@/components/helm/frame";

function HelmPanel() {
  return <HelmApp />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "helm", title: "Helm", icon: "Workflow", path: "helm", component: HelmPanel });
});
