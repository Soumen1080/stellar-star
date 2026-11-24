export const metadata = {
  title: "API lifecycle | StellarStar",
  description: "Versioning, compatibility, deprecation, and sunset policy for the StellarStar Developer API.",
};

export default function ApiLifecyclePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16 text-slate-100">
      <h1 className="text-3xl font-semibold">Developer API lifecycle</h1>
      <p className="mt-5 text-slate-300">The /api/v1 contract remains additive. Breaking changes require a new major API version.</p>
      <h2 className="mt-8 text-xl font-semibold">Deprecation and sunset</h2>
      <p className="mt-3 text-slate-300">We publish a migration guide and give at least 180 days of notice before retiring an API version. During the announced window, responses include Deprecation and Sunset headers with a link to this policy.</p>
      <h2 className="mt-8 text-xl font-semibold">Compatibility checks</h2>
      <p className="mt-3 text-slate-300">The OpenAPI compatibility snapshot is checked in CI. Removed operations, required inputs, enum values, response codes, or changed types fail the compatibility check.</p>
    </main>
  );
}
