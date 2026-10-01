import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureEditingSubscriptionHandoff,
  consumeEditingSubscriptionHandoff,
  useUIStore,
} from "./ui-store";

const subscription = {
  id: "sub-1",
  token: "token-1",
  name: "Primary",
  autoUpdateInterval: 86400,
  smartNodeMatchingEnabled: true,
};

function installSessionStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
        removeItem: (key: string) => void values.delete(key),
      },
    },
  });
  return values;
}

describe("useUIStore", () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    useUIStore.setState({ editingSubscription: null });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  });

  it("stores and clears the in-memory editing subscription", () => {
    useUIStore.getState().setEditingSubscription(subscription);
    expect(useUIStore.getState().editingSubscription).toEqual(subscription);

    useUIStore.getState().clearEditingSubscription();
    expect(useUIStore.getState().editingSubscription).toBeNull();
  });

  it("hands the editing subscription across a login redirect exactly once", () => {
    installSessionStorage();
    useUIStore.getState().setEditingSubscription(subscription);

    captureEditingSubscriptionHandoff();
    useUIStore.setState({ editingSubscription: null });

    expect(consumeEditingSubscriptionHandoff()).toEqual(subscription);
    expect(consumeEditingSubscriptionHandoff()).toBeNull();
  });

  it("clears a stale handoff when nothing is being edited and rejects malformed data", () => {
    const values = installSessionStorage();
    useUIStore.getState().setEditingSubscription(subscription);
    captureEditingSubscriptionHandoff();
    useUIStore.setState({ editingSubscription: null });
    captureEditingSubscriptionHandoff();
    expect(consumeEditingSubscriptionHandoff()).toBeNull();

    values.set("subboost-auth-editing-handoff", JSON.stringify({ createdAt: Date.now(), subscription: { id: 1 } }));
    expect(consumeEditingSubscriptionHandoff()).toBeNull();
    values.set(
      "subboost-auth-editing-handoff",
      JSON.stringify({ createdAt: Date.now() - 11 * 60 * 1000, subscription })
    );
    expect(consumeEditingSubscriptionHandoff()).toBeNull();
  });
});
