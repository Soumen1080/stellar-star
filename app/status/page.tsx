import type { Metadata } from "next";
import Link from "next/link";
import { AlertOctagon, AlertTriangle, CheckCircle2, CircleHelp } from "lucide-react";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import { getPublicStatus, type ComponentState, type PublicIncident } from "@/lib/status/evaluate";
import { INCIDENT_POLICY } from "@/lib/status/incidents";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "System Status | Stellar-star",
  description: "Live status of the Stellar-star app, database, notifications, quotes and reconciliation, with incident updates.",
};

const STATE_STYLE: Record<ComponentState, { badge: string; Icon: typeof CheckCircle2 }> = {
  operational: { badge: "bg-emerald-50 text-emerald-800 border-emerald-200", Icon: CheckCircle2 },
  degraded: { badge: "bg-amber-50 text-amber-900 border-amber-200", Icon: AlertTriangle },
  outage: { badge: "bg-red-50 text-red-800 border-red-200", Icon: AlertOctagon },
  unknown: { badge: "bg-zinc-100 text-zinc-700 border-zinc-200", Icon: CircleHelp },
};

function StateBadge({ state, label }: { state: ComponentState; label: string }) {
  const { badge, Icon } = STATE_STYLE[state];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm font-semibold ${badge}`}>
      <Icon size={15} aria-hidden="true" />
      {label}
    </span>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

function IncidentCard({ incident, names }: { incident: PublicIncident; names: Record<string, string> }) {
  return (
    <article className="rounded-2xl border border-[#E5E5E5] bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-lg font-semibold text-[#0F0F14]">{incident.title}</h3>
        <span className="rounded-full bg-[#0F0F14] px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-white">
          {incident.severityLabel}
        </span>
      </div>
      <p className="mt-1 text-sm text-[#555]">
        Affects {incident.components.map((id) => names[id] ?? id).join(", ")} · Owner: {incident.owner} · Started{" "}
        <time dateTime={incident.startedAt}>{formatTime(incident.startedAt)}</time>
        {incident.resolvedAt ? (
          <>
            {" "}· Resolved <time dateTime={incident.resolvedAt}>{formatTime(incident.resolvedAt)}</time>
          </>
        ) : null}
      </p>
      {incident.updateOverdue ? (
        <p className="mt-2 text-sm font-semibold text-amber-900">
          An update is overdue. The team is still working on this incident.
        </p>
      ) : null}
      <ol className="mt-4 space-y-3 border-l-2 border-[#E5E5E5] pl-4">
        {incident.updates.map((update) => (
          <li key={`${update.at}-${update.status}`}>
            <p className="text-sm">
              <span className="font-semibold capitalize text-[#0F0F14]">{update.status}</span>{" "}
              <span className="text-[#555]">
                · <time dateTime={update.at}>{formatTime(update.at)}</time>
              </span>
            </p>
            <p className="mt-0.5 leading-6 text-[#1F1F24]">{update.message}</p>
          </li>
        ))}
      </ol>
      {incident.postmortemUrl ? (
        <p className="mt-4 text-sm">
          <a href={incident.postmortemUrl} className="font-semibold text-[#0F766E] underline underline-offset-2">
            Read the postmortem
          </a>
        </p>
      ) : incident.resolutionSummary ? (
        <p className="mt-4 text-sm text-[#444]">{incident.resolutionSummary}</p>
      ) : null}
    </article>
  );
}

export default async function StatusPage() {
  const status = await getPublicStatus();
  const names = Object.fromEntries(status.components.map((c) => [c.id, c.name]));

  return (
    <>
      <Header />
      <main id="main-content" className="mx-auto max-w-3xl px-4 pb-20 pt-28 text-[#0F0F14] sm:px-6">
        <h1 className="text-3xl font-bold sm:text-4xl">System status</h1>

        <section
          aria-labelledby="overall-heading"
          className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#E5E5E5] bg-white p-5 shadow-sm"
        >
          <div>
            <h2 id="overall-heading" className="text-xl font-semibold">
              {status.overall.label}
            </h2>
            <p className="mt-1 text-sm text-[#555]">
              Checked <time dateTime={status.checkedAt}>{formatTime(status.checkedAt)}</time>
              {status.overall.notReporting > 0
                ? ` · ${status.overall.notReporting} ${status.overall.notReporting === 1 ? "component is" : "components are"} not reporting live health`
                : ""}
            </p>
          </div>
          <StateBadge
            state={status.overall.state}
            label={status.overall.state === "operational" ? "Operational" : status.overall.state === "outage" ? "Outage" : "Degraded"}
          />
        </section>

        {status.activeIncidents.length > 0 ? (
          <section aria-labelledby="active-heading" className="mt-10">
            <h2 id="active-heading" className="text-xl font-semibold">
              Current incidents
            </h2>
            <div className="mt-4 space-y-4">
              {status.activeIncidents.map((incident) => (
                <IncidentCard key={incident.id} incident={incident} names={names} />
              ))}
            </div>
          </section>
        ) : null}

        <section aria-labelledby="components-heading" className="mt-10">
          <h2 id="components-heading" className="text-xl font-semibold">
            Components
          </h2>
          <ul className="mt-4 divide-y divide-[#E5E5E5] overflow-hidden rounded-2xl border border-[#E5E5E5] bg-white shadow-sm">
            {status.components.map((component) => (
              <li key={component.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="font-semibold">{component.name}</h3>
                  <p className="text-sm text-[#555]">{component.description}</p>
                  <p className="mt-1 text-sm text-[#1F1F24]">{component.message}</p>
                </div>
                <StateBadge state={component.state} label={component.label} />
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="recent-heading" className="mt-10">
          <h2 id="recent-heading" className="text-xl font-semibold">
            Resolved in the last 14 days
          </h2>
          {status.recentIncidents.length > 0 ? (
            <div className="mt-4 space-y-4">
              {status.recentIncidents.map((incident) => (
                <IncidentCard key={incident.id} incident={incident} names={names} />
              ))}
            </div>
          ) : (
            <p className="mt-3 text-[#555]">No incidents in the last 14 days.</p>
          )}
        </section>

        <section aria-labelledby="cadence-heading" className="mt-10 rounded-2xl bg-white p-5 text-sm leading-6 shadow-sm">
          <h2 id="cadence-heading" className="text-base font-semibold">
            How we post updates
          </h2>
          <ul className="mt-2 space-y-1 text-[#333]">
            {Object.values(INCIDENT_POLICY).map((policy) => (
              <li key={policy.label}>
                <span className="font-semibold">{policy.label}</span>: {policy.meaning} Updated at least every{" "}
                {policy.updateEveryMinutes >= 60
                  ? `${policy.updateEveryMinutes / 60} ${policy.updateEveryMinutes === 60 ? "hour" : "hours"}`
                  : `${policy.updateEveryMinutes} minutes`}
                .
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[#555]">
            “Not reporting” means there is no live signal for that component on this deployment. It is not an
            all-clear. Payments already on the Stellar network are never lost when recording is delayed. See{" "}
            <Link href="/help/service-status" className="font-semibold text-[#0F766E] underline underline-offset-2">
              When the service isn’t working
            </Link>
            .
          </p>
        </section>
      </main>
      <Footer />
    </>
  );
}
