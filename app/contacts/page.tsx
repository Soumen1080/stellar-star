"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Contact as ContactIcon, Plus } from "lucide-react";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { ContactCard } from "@/components/contacts/ContactCard";
import { ContactForm } from "@/components/contacts/ContactForm";
import { ConnectWalletButton } from "@/components/wallet/ConnectWalletButton";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useContacts } from "@/hooks/useContacts";
import type { Contact, ContactInput } from "@/types/contact";

export default function ContactsPage() {
  const {
    contacts,
    changes,
    isLoading,
    error,
    addContact,
    editContact,
    removeContact,
    createClaimLink,
    startWalletChange,
    finishWalletChange,
    abandonWalletChange,
  } = useContacts();
  const { success: toastSuccess, error: toastError } = useToast();
  const [editing, setEditing] = useState<Contact | "new" | null>(null);
  const [saving, setSaving] = useState(false);

  const fail = (title: string) => (err: unknown) =>
    toastError(title, err instanceof Error ? err.message : "Please try again.");

  const handleSave = async (input: ContactInput) => {
    setSaving(true);
    try {
      if (editing && editing !== "new") await editContact(editing, input);
      else await addContact(input);
      toastSuccess("Contact saved", input.displayName.trim());
      setEditing(null);
    } catch (err) {
      fail("Could not save contact")(err);
    } finally {
      setSaving(false);
    }
  };

  const handleClaimLink = async (contact: Contact) => {
    try {
      const { url } = await createClaimLink(contact.id);
      await navigator.clipboard?.writeText(url).catch(() => undefined);
      toastSuccess(
        "Claim link copied",
        `Send it to ${contact.displayName}. Signing in with their wallet verifies it. Valid for 7 days.`,
      );
    } catch (err) {
      fail("Could not create claim link")(err);
    }
  };

  return (
    <AuthGuard>
      <div className="min-h-screen bg-[#F6F6F6]">
        <nav className="sticky top-0 z-40 flex items-center justify-between gap-2 px-4 sm:px-6 py-3 border-b border-[#E5E5E5] bg-white/90 backdrop-blur-xl">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <Link href="/dashboard" className="flex items-center gap-1.5 text-sm text-[#888] hover:text-[#0F0F14]">
              <ArrowLeft size={14} />
              <span className="hidden sm:inline">Dashboard</span>
            </Link>
            <span className="text-[#E5E5E5] hidden sm:inline">/</span>
            <span className="text-sm font-bold text-[#0F0F14] truncate">Contacts</span>
          </div>
          <ConnectWalletButton className="shrink-0" />
        </nav>

        <main className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="flex items-center gap-2">
              <ContactIcon size={16} className="text-[#2DD4BF]" />
              <h1 className="text-xl font-black text-[#0F0F14]">Contacts</h1>
            </div>
            <button
              onClick={() => setEditing("new")}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#0F0F14] text-[#2DD4BF] text-sm font-bold hover:bg-[#1A1A22]"
            >
              <Plus size={14} />
              New
            </button>
          </div>
          <p className="text-sm text-[#888] mb-6">
            Private to you. A wallet is marked verified only after its owner claims the contact.
          </p>

          {error && <p className="mb-4 text-sm text-red-500">{error}</p>}

          {isLoading ? (
            <div className="flex justify-center py-12">
              <Spinner size={32} className="text-[#2DD4BF]" />
            </div>
          ) : contacts.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[#E5E5E5] bg-white px-4 py-10 text-center text-sm text-[#AAA]">
              No contacts yet. Save the people you split with so you never retype a wallet.
            </p>
          ) : (
            <ul className="space-y-3">
              {contacts.map((contact) => (
                <ContactCard
                  key={contact.id}
                  contact={contact}
                  pendingChange={changes.find(
                    (c) => c.contactId === contact.id && c.status === "pending_notice",
                  )}
                  onEdit={() => setEditing(contact)}
                  onDelete={() => {
                    if (!window.confirm(`Delete ${contact.displayName}? Trips are not affected.`)) return;
                    removeContact(contact.id).catch(fail("Could not delete contact"));
                  }}
                  onClaimLink={() => handleClaimLink(contact)}
                  onRequestChange={async (wallet) => {
                    const change = await startWalletChange(contact.id, wallet);
                    toastSuccess(
                      "Wallet change requested",
                      change.affectedTripIds.length > 0
                        ? `${change.affectedTripIds.length} active trip(s) are being notified.`
                        : "No active trips use the old address — you can apply it now.",
                    );
                  }}
                  onApplyChange={(change) =>
                    finishWalletChange(change.id)
                      .then(() => toastSuccess("Wallet updated", "Past payments keep their original address."))
                      .catch(fail("Could not apply change"))
                  }
                  onCancelChange={(change) =>
                    abandonWalletChange(change.id).catch(fail("Could not cancel change"))
                  }
                />
              ))}
            </ul>
          )}
        </main>
      </div>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "New contact" : "Edit contact"}
        size="md"
      >
        {editing !== null && (
          <ContactForm
            key={editing === "new" ? "new" : editing.id}
            contact={editing === "new" ? undefined : editing}
            existing={contacts}
            submitting={saving}
            onSubmit={handleSave}
            onCancel={() => setEditing(null)}
          />
        )}
      </Modal>
    </AuthGuard>
  );
}
