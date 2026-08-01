/**
 * Privacy policy.
 *
 * Kept as a real route rather than a static site because the app stores require
 * a reachable privacy policy and a reviewer follows the link by hand.
 *
 * The claims here were previously backed by "you can read the source code".
 * That is no longer offered — the repository is private — so the wording has
 * been changed to say what is true rather than to keep an appeal to evidence
 * nobody can check. What the encryption does has not changed; only what can be
 * verified from outside.
 */
import { PageLayout, Section } from '../components/PageLayout';

const SUPPORT_EMAIL = 'support@nmetalk.com';

export default function Privacy() {
  return (
    <PageLayout
      title="Privacy"
      updated="1 August 2026"
      intro={
        <>
          NME Talk is an end-to-end encrypted video meeting app. This page describes what
          the service handles, what it deliberately cannot handle, and where the boundaries
          actually are.
        </>
      }
    >
      <Section title="The short version">
        <p>
          There are no accounts. Nothing you say, type, or show is recorded, and none of it
          can be read by the server, because the key that decrypts it never reaches the
          server. What the server does see is that a meeting happened, roughly when, and the
          network addresses that connected to it — the metadata any server necessarily
          observes in order to route traffic.
        </p>
      </Section>

      <Section title="What is not collected">
        <ul className="list-disc space-y-2 pl-5">
          <li>No account, email address, phone number, or password.</li>
          <li>
            No cookies. No analytics, no advertising identifier, no tracking pixels, no
            third-party scripts of any kind.
          </li>
          <li>
            No recordings, transcripts, or chat history — none are created, so none exist to
            be requested, leaked, or subpoenaed.
          </li>
        </ul>
      </Section>

      <Section title="What cannot be collected, even in principle">
        <p>
          Audio, video, screen shares, and chat messages are encrypted with AES-GCM on your
          device before they reach the network, and decrypted only on the devices of other
          participants. The encryption key is carried in the fragment of the meeting link —
          the part after the <code className="rounded bg-elevated px-1 py-px text-[0.8125rem]">#</code>{' '}
          — which browsers do not transmit in HTTP requests. The server therefore relays
          traffic it holds no key for.
        </p>
        <p>
          This is a structural property, not a policy: there is no configuration setting, no
          legal instrument, and no software update within the design that would let the
          operator read a meeting&rsquo;s contents.
        </p>
      </Section>

      <Section title="What is handled, and for how long">
        <dl className="space-y-4">
          <Entry term="Display name">
            The name you type before joining. Sent to other participants so they can see who
            is speaking, and included in the short-lived join token. Never written to a
            database, and explicitly filtered out of server logs.
          </Entry>
          <Entry term="IP address">
            Observed by the server in order to answer the request at all, and recorded in
            operational logs used for rate limiting and abuse handling, as on any web server.
            Logs rotate and are not retained long-term.
          </Entry>
          <Entry term="Room identifier">
            Derived by hashing the encryption key, so the server can hold a room open without
            learning anything about the key. Held in memory only, and discarded shortly after
            the meeting ends.
          </Entry>
          <Entry term="Join tokens and rate-limit counters">
            Held briefly in Redis, which is configured with persistence disabled — nothing is
            written to disk, so a restart erases all of it.
          </Entry>
        </dl>
      </Section>

      <Section title="Operational counts">
        <p>
          The server keeps aggregate counters so its operator can see whether it is
          overloaded or under attack: how many meetings were created in an hour, how many
          people joined, how many joins were refused and why, and how long meetings tend to
          last as a distribution.
        </p>
        <p>
          These are counts and nothing else. There are no per-meeting records, no room
          identifiers, and no addresses among them — a room identifier is derived from the
          encryption key, so retaining one alongside a timestamp would let anyone holding an
          old link establish that a particular meeting took place. The counters live in memory
          and are lost when the server restarts.
        </p>
      </Section>

      <Section title="Stored on your device">
        <p>A small amount of information stays on your own device and is never transmitted:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>Your display name, so you do not retype it before every meeting.</li>
          <li>Your camera and microphone preferences.</li>
          <li>
            For meetings you created, a key that lets you admit people without knocking at
            your own door.
          </li>
        </ul>
        <p>
          Meeting encryption keys are deliberately not stored. Keeping them would turn a lost
          or stolen device into a key to every past meeting, in an app whose whole claim is
          that conversations leave no readable trace.
        </p>
      </Section>

      <Section title="Camera and microphone">
        <p>
          Both are used only while you are in a meeting, and only after your device asks your
          permission. Nothing is captured before you join or after you leave, and nothing is
          recorded at any point. Turning your camera off releases it, which is why the
          operating system&rsquo;s recording indicator goes out.
        </p>
      </Section>

      <Section title="Third parties">
        <p>
          NME Talk uses no third-party services during a normal meeting. There is one
          exception, and it engages only when your network blocks a direct connection — a
          restrictive corporate or public firewall, typically. In that case, and only after a
          direct connection has already failed, the call is routed through a TURN relay
          operated by Cloudflare.
        </p>
        <p>
          The relay forwards media that is already encrypted twice over and cannot read any of
          it. It does observe that a connection exists and the network address it comes from.
          The app tells you when this is happening, with a &ldquo;Connected via relay&rdquo;
          indicator, because you are entitled to know when your traffic takes a different path.
        </p>
      </Section>

      <Section title="Limits worth understanding">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="font-medium text-fg">Anyone with the link can join.</strong> The
            link contains the key. Treat it the way you would treat a password, and prefer a
            channel you trust to carry it.
          </li>
          <li>
            <strong className="font-medium text-fg">Metadata is visible to the server.</strong>{' '}
            That a meeting occurred, when, for how long, and which addresses joined.
          </li>
          <li>
            <strong className="font-medium text-fg">Participants can record.</strong> Everyone
            in a call necessarily holds decrypted media. No software can prevent a screen
            recorder or a second phone pointed at the screen, and any product claiming
            otherwise is mistaken.
          </li>
        </ul>
      </Section>

      <Section title="Reports and abuse">
        <p>
          You can report a meeting. A report carries the room identifier and a timestamp, and
          nothing else, because nothing else exists in readable form. That means reports can be
          acted on by revoking a room and by blocking a network address — but not by reviewing
          what was said, which is impossible here by design. We would rather state that plainly
          than imply an investigation that cannot happen.
        </p>
      </Section>

      <Section title="Children">
        <p>
          NME Talk is not directed at children and collects no information from anyone,
          including children.
        </p>
      </Section>

      <Section title="Changes">
        <p>Material changes to this page will be reflected in the date at the top.</p>
      </Section>

      <Section title="Contact">
        <p>
          Questions about privacy, a report to make, or a security issue to raise:{' '}
          <a className="text-accent underline" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
      </Section>
    </PageLayout>
  );
}

function Entry({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[0.9375rem] font-medium text-fg">{term}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}
