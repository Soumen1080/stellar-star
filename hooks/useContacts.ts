"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyWalletChange,
  cancelWalletChange,
  createContactClaimLink,
  deleteContact,
  fetchContacts,
  fetchWalletChanges,
  insertContact,
  requestWalletChange,
  updateContact,
} from "@/lib/contacts/queries";
import { useWallet } from "@/hooks/useWallet";
import type { Contact, ContactInput, ContactWalletChange } from "@/types/contact";

/**
 * The signed-in wallet's private contacts and their pending wallet changes.
 * Loads lazily when `enabled` turns true, so pages that only sometimes need
 * contacts (the new-trip modal) do not pay for them on every render.
 */
export function useContacts(enabled = true) {
  const { publicKey } = useWallet();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [changes, setChanges] = useState<ContactWalletChange[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [rows, changeRows] = await Promise.all([fetchContacts(), fetchWalletChanges()]);
      if (!mounted.current) return;
      setContacts(rows);
      setChanges(changeRows);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : "Could not load contacts.");
    } finally {
      if (mounted.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (enabled && publicKey) void refresh();
    return () => {
      mounted.current = false;
    };
  }, [enabled, publicKey, refresh]);

  const upsert = (saved: Contact) =>
    setContacts((previous) =>
      [...previous.filter((c) => c.id !== saved.id), saved].sort((a, b) =>
        a.displayName.localeCompare(b.displayName),
      ),
    );

  const addContact = useCallback(
    async (input: ContactInput) => {
      if (!publicKey) throw new Error("Connect your wallet to save contacts.");
      const saved = await insertContact(publicKey, input);
      upsert(saved);
      return saved;
    },
    [publicKey],
  );

  const editContact = useCallback(async (contact: Contact, input: ContactInput) => {
    const saved = await updateContact(contact, input);
    upsert(saved);
    return saved;
  }, []);

  const removeContact = useCallback(async (id: string) => {
    await deleteContact(id);
    setContacts((previous) => previous.filter((c) => c.id !== id));
    setChanges((previous) => previous.filter((c) => c.contactId !== id));
  }, []);

  const createClaimLink = useCallback(async (contactId: string) => {
    const link = await createContactClaimLink(contactId, window.location.origin);
    setContacts((previous) =>
      previous.map((c) => (c.id === contactId ? { ...c, hasPendingClaim: true } : c)),
    );
    return link;
  }, []);

  const startWalletChange = useCallback(async (contactId: string, newWallet: string) => {
    const change = await requestWalletChange(contactId, newWallet);
    setChanges((previous) => [
      change,
      ...previous.map((c) =>
        c.contactId === contactId && c.status === "pending_notice"
          ? { ...c, status: "cancelled" as const }
          : c,
      ),
    ]);
    return change;
  }, []);

  const finishWalletChange = useCallback(async (changeId: string) => {
    const saved = await applyWalletChange(changeId);
    upsert(saved);
    setChanges((previous) =>
      previous.map((c) =>
        c.id === changeId ? { ...c, status: "applied" as const, appliedAt: new Date().toISOString() } : c,
      ),
    );
    return saved;
  }, []);

  const abandonWalletChange = useCallback(async (changeId: string) => {
    await cancelWalletChange(changeId);
    setChanges((previous) =>
      previous.map((c) => (c.id === changeId ? { ...c, status: "cancelled" as const } : c)),
    );
  }, []);

  return {
    contacts,
    changes,
    isLoading,
    error,
    refresh,
    addContact,
    editContact,
    removeContact,
    createClaimLink,
    startWalletChange,
    finishWalletChange,
    abandonWalletChange,
  };
}
