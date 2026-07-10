"use client";

import { useFormState, useFormStatus } from "react-dom";
import { addUser } from "../../app/admin/actions";

type Manager = { key: string; name: string; ownerId: string | null; parent?: string };
type Pod = { key: string; name: string; leadEmail: string | null };
type Result = { ok: boolean; message: string } | null;

const inputCls = "rounded-lg border border-slate-200 px-2 py-1.5 text-sm";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      disabled={pending}
      className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
    >
      {pending ? "Saving & verifying…" : "Add / update user"}
    </button>
  );
}

/** Add/update-user form. Uses useFormState so the server action's DB-verified result is shown as a
 *  confirmation banner (success reflects a real read-back from the database, not an optimistic UI). */
export function AddUserForm({ managers, pods }: { managers: Manager[]; pods: Pod[] }) {
  const [state, formAction] = useFormState<Result, FormData>(addUser, null);
  const mgrName = new Map(managers.map((m) => [m.key, m.name]));
  return (
    <div>
      {state && (
        <div
          role="status"
          className={`mb-3 rounded-lg border px-3 py-2 text-sm ${
            state.ok ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-rose-300 bg-rose-50 text-rose-800"
          }`}
        >
          {state.message}
        </div>
      )}
      <form action={formAction} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <input name="first_name" placeholder="First name" className={inputCls} />
        <input name="last_name" placeholder="Last name" className={inputCls} />
        <input name="email" required placeholder="name@spyne.ai" className={inputCls} />
        <select name="role" className={inputCls} defaultValue="user" aria-label="Access role">
          <option value="user">Role: User</option>
          <option value="manager">Role: Manager</option>
          <option value="admin">Role: Admin</option>
        </select>
        <select name="kind" className={inputCls} defaultValue="sdr" aria-label="Type">
          <option value="sdr">Type: SDR (tracked rep)</option>
          <option value="ae">Type: AE (tracked rep)</option>
          <option value="access">Type: Access only (not a rep)</option>
        </select>
        <div className="hidden lg:block" />
        <select name="manager_key" className={inputCls} defaultValue="" aria-label="SDR team">
          <option value="">SDR team — None</option>
          {managers.map((m) => (
            <option key={m.key} value={m.key}>
              {m.name}
              {m.parent ? ` (TL → ${mgrName.get(m.parent) ?? m.parent})` : ""}
            </option>
          ))}
        </select>
        <select name="ae_pod" className={inputCls} defaultValue="" aria-label="AE pod">
          <option value="">AE pod — None</option>
          {pods.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
              {p.leadEmail ? ` (${p.leadEmail})` : ""}
            </option>
          ))}
        </select>
        <div className="sm:col-span-2 lg:col-span-3">
          <SubmitButton />
        </div>
      </form>
    </div>
  );
}
