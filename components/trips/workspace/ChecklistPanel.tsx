"use client";

import React, { useState } from "react";
import { CheckSquare, Square, Plus, Trash2, User, Luggage, FileText, CheckCircle2 } from "lucide-react";
import type { Member } from "@/types/expense";
import type { ChecklistCategory, ChecklistItem } from "@/types/workspace";

interface ChecklistPanelProps {
  checklists: ChecklistItem[];
  members: Member[];
  currentUserWallet?: string | null;
  onAddItem: (item: Omit<ChecklistItem, "id" | "tripId" | "createdAt">) => Promise<any>;
  onToggleItem: (itemId: string) => Promise<void>;
  onDeleteItem: (itemId: string) => Promise<void>;
  onUpdateItem: (itemId: string, updates: Partial<ChecklistItem>) => Promise<void>;
}

const CATEGORIES: { label: string; value: ChecklistCategory; icon: React.ComponentType<{ size?: number }> }[] = [
  { label: "All Items", value: "general" as any, icon: CheckSquare },
  { label: "Packing List", value: "packing", icon: Luggage },
  { label: "Documents", value: "documents", icon: FileText },
  { label: "Pre-Trip To-Dos", value: "todo", icon: CheckCircle2 },
];

export function ChecklistPanel({
  checklists,
  members,
  currentUserWallet,
  onAddItem,
  onToggleItem,
  onDeleteItem,
  onUpdateItem,
}: ChecklistPanelProps) {
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [newTitle, setNewTitle] = useState("");
  const [newCategory, setNewCategory] = useState<ChecklistCategory>("packing");
  const [newAssignedMemberId, setNewAssignedMemberId] = useState<string>("");
  const [adding, setAdding] = useState(false);

  const filteredItems = checklists.filter((item) => {
    if (activeCategory === "all") return true;
    return item.category === activeCategory;
  });

  const completedCount = checklists.filter((c) => c.isCompleted).length;
  const progressPercent = checklists.length > 0
    ? Math.round((completedCount / checklists.length) * 100)
    : 0;

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;

    setAdding(true);
    try {
      await onAddItem({
        title: newTitle.trim(),
        category: newCategory,
        isCompleted: false,
        assignedToMemberId: newAssignedMemberId || null,
        addedByWallet: currentUserWallet ?? undefined,
      });
      setNewTitle("");
    } finally {
      setAdding(false);
    }
  };

  const getMemberName = (memberId?: string | null) => {
    if (!memberId) return null;
    return members.find((m) => m.id === memberId)?.name ?? "Member";
  };

  return (
    <div className="space-y-4">
      {/* Progress & Category filters */}
      <div className="p-4 bg-white rounded-2xl border border-[#EBEBEB] space-y-3 shadow-sm">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-[#0F0F14]">Checklist Progress</span>
          <span className="font-mono text-[#777]">
            {completedCount} of {checklists.length} completed ({progressPercent}%)
          </span>
        </div>
        <div className="w-full h-2 bg-[#EBEBEB] rounded-full overflow-hidden">
          <div
            className="h-full bg-[#2DD4BF] rounded-full transition-all duration-300"
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        {/* Filter buttons */}
        <div className="flex flex-wrap gap-1.5 pt-1">
          <button
            type="button"
            onClick={() => setActiveCategory("all")}
            className={`px-2.5 py-1 text-xs font-semibold rounded-lg transition-colors ${
              activeCategory === "all"
                ? "bg-[#0F0F14] text-white"
                : "bg-[#F6F6F6] text-[#777] hover:text-[#0F0F14]"
            }`}
          >
            All ({checklists.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveCategory("packing")}
            className={`px-2.5 py-1 text-xs font-semibold rounded-lg transition-colors ${
              activeCategory === "packing"
                ? "bg-[#0F0F14] text-white"
                : "bg-[#F6F6F6] text-[#777] hover:text-[#0F0F14]"
            }`}
          >
            Packing ({checklists.filter((c) => c.category === "packing").length})
          </button>
          <button
            type="button"
            onClick={() => setActiveCategory("documents")}
            className={`px-2.5 py-1 text-xs font-semibold rounded-lg transition-colors ${
              activeCategory === "documents"
                ? "bg-[#0F0F14] text-white"
                : "bg-[#F6F6F6] text-[#777] hover:text-[#0F0F14]"
            }`}
          >
            Documents ({checklists.filter((c) => c.category === "documents").length})
          </button>
          <button
            type="button"
            onClick={() => setActiveCategory("todo")}
            className={`px-2.5 py-1 text-xs font-semibold rounded-lg transition-colors ${
              activeCategory === "todo"
                ? "bg-[#0F0F14] text-white"
                : "bg-[#F6F6F6] text-[#777] hover:text-[#0F0F14]"
            }`}
          >
            To-Dos ({checklists.filter((c) => c.category === "todo").length})
          </button>
        </div>
      </div>

      {/* Add new task form */}
      <form onSubmit={handleAdd} className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Add packing item, document, or task..."
          className="flex-1 px-3 py-2 text-xs bg-white border border-[#DDD] rounded-xl focus:border-[#2DD4BF] focus:outline-none"
        />
        <select
          value={newCategory}
          onChange={(e) => setNewCategory(e.target.value as ChecklistCategory)}
          className="px-3 py-2 text-xs bg-white border border-[#DDD] rounded-xl focus:border-[#2DD4BF] focus:outline-none"
        >
          <option value="packing">Packing</option>
          <option value="documents">Documents</option>
          <option value="todo">To-Do</option>
          <option value="general">General</option>
        </select>
        <select
          value={newAssignedMemberId}
          onChange={(e) => setNewAssignedMemberId(e.target.value)}
          className="px-3 py-2 text-xs bg-white border border-[#DDD] rounded-xl focus:border-[#2DD4BF] focus:outline-none"
        >
          <option value="">Assign: Anyone</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              Assign: {m.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={adding || !newTitle.trim()}
          className="inline-flex items-center justify-center gap-1 px-4 py-2 text-xs font-bold text-[#0F0F14] bg-[#2DD4BF] hover:bg-[#26b8a5] rounded-xl transition-all disabled:opacity-50 shadow-sm"
        >
          <Plus size={14} />
          Add
        </button>
      </form>

      {/* Checklist items list */}
      <div className="space-y-2">
        {filteredItems.length === 0 ? (
          <div className="text-center py-10 bg-white rounded-2xl border border-dashed border-[#DDD] text-[#888] text-xs">
            No checklist items yet in this category. Add your packing essentials or pre-trip tasks!
          </div>
        ) : (
          filteredItems.map((item) => {
            const assignedName = getMemberName(item.assignedToMemberId);
            return (
              <div
                key={item.id}
                className={`flex items-center justify-between p-3 rounded-xl border transition-all ${
                  item.isCompleted
                    ? "bg-[#FAFAFA] border-[#EBEBEB] text-[#999]"
                    : "bg-white border-[#E5E5E5] text-[#0F0F14] shadow-sm"
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <button
                    type="button"
                    onClick={() => onToggleItem(item.id)}
                    aria-label={item.isCompleted ? "Mark incomplete" : "Mark complete"}
                    className="shrink-0 text-[#2DD4BF] hover:scale-110 transition-transform"
                  >
                    {item.isCompleted ? (
                      <CheckSquare size={18} className="fill-[#2DD4BF] text-white" />
                    ) : (
                      <Square size={18} className="text-[#CCC] hover:text-[#2DD4BF]" />
                    )}
                  </button>

                  <span
                    className={`text-xs font-medium truncate ${
                      item.isCompleted ? "line-through text-[#999]" : ""
                    }`}
                  >
                    {item.title}
                  </span>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span className="px-2 py-0.5 text-[10px] uppercase font-bold rounded-md bg-[#F0F0F0] text-[#777]">
                    {item.category}
                  </span>

                  {assignedName ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-md bg-[#2DD4BF]/10 text-[#0F0F14]">
                      <User size={10} className="text-[#2DD4BF]" />
                      {assignedName}
                    </span>
                  ) : (
                    <select
                      value=""
                      onChange={(e) =>
                        onUpdateItem(item.id, { assignedToMemberId: e.target.value || null })
                      }
                      className="text-[10px] text-[#999] bg-transparent border-0 cursor-pointer focus:outline-none hover:text-[#0F0F14]"
                    >
                      <option value="">+ Assign</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  )}

                  <button
                    type="button"
                    onClick={() => onDeleteItem(item.id)}
                    aria-label="Delete item"
                    className="p-1 text-[#AAA] hover:text-red-600 rounded transition-colors"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
