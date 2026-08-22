import { Navigate, Route, Router } from "@solidjs/router";
import { Show } from "solid-js";

import { AuthProvider, useAuth } from "./auth.js";
import { initialWorkspacePath } from "./demo-people.js";
import { GatewayProvider } from "./gateway.js";
import { LoginPage } from "./routes/LoginPage.js";
import { WorkspacePage } from "./routes/WorkspacePage.js";

export function App() {
  return (
    <AuthProvider>
      <Router>
        <Route path="/" component={HomeRoute} />
        <Route path="/login" component={LoginRoute} />
        <Route path="/projects" component={ProtectedWorkspaceRoute} />
        <Route path="/tasks" component={ProtectedWorkspaceRoute} />
        <Route path="/team" component={ProtectedWorkspaceRoute} />
        <Route
          path="/projects/:projectId"
          component={ProtectedWorkspaceRoute}
        />
        <Route path="*" component={HomeRoute} />
      </Router>
    </AuthProvider>
  );
}

function HomeRoute() {
  const auth = useAuth();
  return <Navigate href={initialWorkspacePath(auth.userId())} />;
}

function LoginRoute() {
  const auth = useAuth();
  return (
    <Show
      when={auth.userId() === undefined}
      fallback={<Navigate href={initialWorkspacePath(auth.userId())} />}
    >
      <LoginPage />
    </Show>
  );
}

function ProtectedWorkspaceRoute() {
  const auth = useAuth();
  return (
    <Show when={auth.userId()} fallback={<Navigate href="/login" />}>
      {(userId) => (
        <GatewayProvider userId={userId}>
          <WorkspacePage />
        </GatewayProvider>
      )}
    </Show>
  );
}
