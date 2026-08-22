import {
  createContext,
  createSignal,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js";

import { findDemoPerson } from "./demo-people.js";

const storageKey = "northstar-demo-user";

type AuthContextValue = Readonly<{
  userId: Accessor<string | undefined>;
  signIn(userId: string): void;
  signOut(): void;
}>;

const AuthContext = createContext<AuthContextValue>();

export function AuthProvider(props: { children: JSX.Element }) {
  const storedUser = sessionStorage.getItem(storageKey) ?? undefined;
  const [userId, setUserId] = createSignal(
    findDemoPerson(storedUser) === undefined ? undefined : storedUser,
  );

  const value: AuthContextValue = Object.freeze({
    userId,
    signIn(nextUserId) {
      if (findDemoPerson(nextUserId) === undefined) {
        throw new Error("Unknown demo identity");
      }
      sessionStorage.setItem(storageKey, nextUserId);
      setUserId(nextUserId);
    },
    signOut() {
      sessionStorage.removeItem(storageKey);
      setUserId(undefined);
    },
  });

  return (
    <AuthContext.Provider value={value}>{props.children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const auth = useContext(AuthContext);
  if (auth === undefined) throw new Error("AuthProvider is missing");
  return auth;
}
