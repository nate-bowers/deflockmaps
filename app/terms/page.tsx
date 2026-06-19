import Link from "next/link";

export const metadata = {
  title: "Terms of Use & Disclaimer — DeFlock Maps",
};

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-white px-6 py-12 text-zinc-800">
      <div className="mx-auto max-w-2xl">
      <Link href="/" className="text-sm text-blue-600 hover:underline">
        ← Back to the map
      </Link>

      <h1 className="mt-4 text-2xl font-bold text-zinc-900">
        Terms of Use &amp; Disclaimer
      </h1>
      <p className="mt-1 text-sm text-zinc-500">Last updated: [last updated date]</p>

      <p className="mt-6">
        <b>DeFlock Maps</b> is a free, non-commercial hobby and educational
        project. It is run by a private individual for fun and learning, not as a
        business. By using it, you agree to everything below.{" "}
        <b>If you do not agree, please do not use the app.</b>
      </p>
      <p className="mt-3">
        This is not legal advice. Nothing here, and nothing the app shows you, is
        legal advice. If you have questions about your rights or about
        surveillance, talk to a qualified attorney.
      </p>

      <Section n="1" title="What this app is">
        <p>
          DeFlock Maps displays the locations of publicly-known automated license
          plate reader (ALPR) cameras — sometimes called &ldquo;Flock&rdquo;
          cameras — and suggests driving routes that try to minimize passing the
          cameras it <i>knows about</i>. You can export those routes to
          third-party apps like Google Maps, Apple Maps, or Waze. It is a
          toy/educational tool, provided <b>as is</b>, for general informational
          purposes only.
        </p>
      </Section>

      <Section n="2" title="The camera data is crowd-sourced, incomplete, and may be wrong">
        <p>
          Camera locations come from the crowd-sourced <b>DeFlock</b> project and{" "}
          <b>OpenStreetMap</b>. That data is incomplete (many cameras are not in
          it); may be wrong, outdated, mislocated, or duplicated; can change at any
          time without notice; and says nothing about cameras or surveillance
          methods that aren&rsquo;t ALPR or aren&rsquo;t publicly mapped.
        </p>
        <p className="mt-3">
          <b>
            A route showing &ldquo;0 cameras&rdquo; is NOT a guarantee that you
            will avoid any camera, ALPR system, or surveillance.
          </b>{" "}
          You may still pass cameras the app doesn&rsquo;t know about, new cameras,
          mobile cameras, or entirely different surveillance technology. Do not
          rely on this app for any safety-critical, legal, or high-stakes decision.
        </p>
      </Section>

      <Section n="3" title="Routes are best-effort only">
        <p>
          Suggested routes are automatically generated, best-effort estimates.
          They may be inefficient, impractical, illegal for your vehicle, closed,
          unsafe, or wrong. <b>You are solely responsible for how you drive.</b>{" "}
          You must obey all traffic laws, signs, and signals; drive safely and
          lawfully at all times; pay attention to the actual road — not the app;
          and not use the app in any way that breaks the law, including to evade,
          obstruct, or interfere with law enforcement. Real-world conditions
          override anything the app suggests.
        </p>
      </Section>

      <Section n="4" title="Exporting to other apps">
        <p>
          When you export a route to Google Maps, Apple Maps, Waze, or any other
          service, you leave DeFlock Maps and enter that third party&rsquo;s
          product, governed by <b>their</b> terms and privacy policies. We
          don&rsquo;t control them, can&rsquo;t see what they do with your data,
          and aren&rsquo;t responsible for their behavior, accuracy, or routing.
        </p>
      </Section>

      <Section n="5" title="No warranty">
        <p className="uppercase text-sm leading-relaxed text-zinc-600">
          The app and all data, routes, and content are provided &ldquo;as
          is&rdquo; and &ldquo;as available,&rdquo; with no warranties of any kind,
          express or implied — including but not limited to accuracy, completeness,
          reliability, fitness for a particular purpose, non-infringement, or that
          the app will be uninterrupted or error-free. You use it entirely at your
          own risk.
        </p>
      </Section>

      <Section n="6" title="Limitation of liability">
        <p>
          To the fullest extent allowed by law, the creator(s) of DeFlock Maps are{" "}
          <b>not liable</b> for any damages, losses, injuries, fines, legal
          consequences, or other harm of any kind arising from or related to your
          use of (or inability to use) the app — including any decision you make
          based on its camera data or routes. This includes direct, indirect,
          incidental, consequential, and punitive damages. Because the app is free,
          no fee has been paid for any kind of guarantee.
        </p>
      </Section>

      <Section n="7" title="Not affiliated with anyone">
        <p>
          DeFlock Maps is an <b>independent</b> project. It is{" "}
          <b>not affiliated with, endorsed by, sponsored by, or connected to</b>{" "}
          Flock Safety or any ALPR manufacturer or vendor; the DeFlock project; the
          OpenStreetMap Foundation or its contributors; or any government, law
          enforcement, or public agency. All trademarks and names belong to their
          respective owners and are used only to describe what the data refers to.
          OpenStreetMap data is © OpenStreetMap contributors and used under its
          license; DeFlock data is used per its terms.
        </p>
      </Section>

      <Section n="8" title="Availability and changes">
        <p>
          This is a hobby project with <b>no uptime guarantee</b>. It may be slow,
          broken, changed, or taken offline at any time, without notice, and
          discontinued permanently — for any reason or no reason. These terms may
          also be updated at any time; continued use means you accept the current
          version.
        </p>
      </Section>

      <Section n="9" title="Privacy">
        <p>This project collects as little as possible.</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>There are no accounts; we don&rsquo;t ask for personal information.</li>
          <li>
            We don&rsquo;t intentionally build a profile of you or sell any data.
          </li>
          <li>
            Addresses you type are sent to a geocoding service, and your start/end
            points are sent to the routing engine, solely to produce directions.
          </li>
          <li>
            Map tiles (OpenStreetMap), geocoding (Nominatim), routing, and any
            route you export receive request data under their own privacy policies.
          </li>
          <li>
            Standard, non-identifying technical logs (e.g. IP address for rate
            limiting, and error reports) may exist purely to keep the app running.
          </li>
        </ul>
      </Section>

      <Section n="10" title="Contact">
        <p>
          Questions? Reach out at <b>[contact]</b>.
        </p>
      </Section>

      <p className="mt-10 border-t border-zinc-200 pt-4 text-xs text-zinc-400">
        This document is a plain-English template, not legal advice. It has not
        been reviewed by an attorney.
      </p>
      </div>
    </main>
  );
}

function Section({
  n,
  title,
  children,
}: {
  n: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <h2 className="text-lg font-semibold text-zinc-900">
        {n}. {title}
      </h2>
      <div className="mt-2 leading-relaxed">{children}</div>
    </section>
  );
}
