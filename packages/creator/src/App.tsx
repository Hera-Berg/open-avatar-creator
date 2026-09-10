import { useEffect } from "react";
import { useStore } from "./state/store";
import { engineHolder } from "./playback/engine";
import { deleteSelected, fitView, toggleLockSelected, toggleMeshEdit } from "./ui/actions";
import { loadOar } from "./export/oarFile";
import { TopBar } from "./components/TopBar";
import { LayerList } from "./components/LayerList";
import { Viewport } from "./components/Viewport";
import { SidePanel } from "./components/SidePanel";
import { AutoRigDialog, ImportDialog, NamingGuide, StudioProblemsDialog } from "./components/Dialogs";

function Toast() {
  const toast = useStore((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => useStore.getState().setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast) return null;
  return <div className="toast">{toast}</div>;
}

export default function App() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
      const s = useStore.getState();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        s.redo();
        return;
      }
      switch (e.key) {
        case " ":
          e.preventDefault();
          engineHolder.current?.togglePause();
          break;
        case "b":
        case "B":
          s.setTool(s.tool === "addBone" ? "select" : "addBone");
          break;
        case "l":
        case "L":
          toggleLockSelected();
          break;
        case "e":
        case "E":
          toggleMeshEdit();
          break;
        case "Delete":
        case "Backspace":
          deleteSelected();
          break;
        case "f":
        case "F":
          fitView();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app">
      <TopBar />
      <div className="main">
        <LayerList />
        <Viewport />
        <SidePanel />
      </div>
      <ImportDialog />
      <NamingGuide />
      <StudioProblemsDialog />
      <AutoRigDialog />
      <Toast />
    </div>
  );
}
