/**
 * How it works.
 *
 * Ported from the old static site, with the claims that depended on a public
 * repository removed rather than restated. "Open source", "read the source",
 * and the clone command all became false the moment the repository went
 * private, and a security page carrying a claim its reader cannot check is
 * worse than one that stays quiet about it.
 *
 * The encryption section is unchanged, because none of that depended on who can
 * read the code — the properties come from where the key lives.
 */
import { PageLayout, Section, Claim } from '../components/PageLayout';
import { routeOnClick } from '../lib/router';

export default function HowItWorks() {
  return (
    <PageLayout
      title="The server relays your meeting. It cannot hear it."
      intro={
        <>
          Audio, video, and messages are encrypted on your device and decrypted only on the
          devices of the people you invited. Nothing in between holds the key — including the
          server.
        </>
      }
    >
      <Section title="Where the key lives">
        <p>
          A meeting link has two halves, and only one of them is ever sent to a server:
        </p>
        <div className="rounded-xl border border-border bg-surface p-4 font-mono text-[0.8125rem] break-all">
          <span className="text-fg">https://nmetalk.com/</span>
          <span className="text-accent">#K7dE2mQx9hBtR4vNc8LpZ1yUwA6sXfJ0oQ3iTgYbHnE</span>
        </div>
        <p>
          Everything after the <code className="rounded bg-elevated px-1 py-px">#</code> is a URL
          fragment, and browsers do not transmit fragments in HTTP requests. That is where the
          encryption key lives. The server issues the room and the join token, and has no way
          to learn the key — so holding the link grants access, and holding the server does not.
        </p>
      </Section>

      <Section title="Two layers, one of which the server is outside of">
        <p>
          Ordinary WebRTC encrypts each hop. Media is protected on the wire, but the routing
          server decrypts it, looks at it, and encrypts it again — which is how nearly every
          meeting product works, and why nearly every one of them can record you.
        </p>
        <p>
          NME Talk adds a second layer underneath. Frames are encrypted with AES-GCM before
          they are handed to WebRTC at all, so the relay forwards ciphertext it has no key for.
          It can still do its job — deciding who needs which quality — because selecting
          between encrypted layers never requires reading them.
        </p>
        <dl className="mt-4 space-y-4">
          <div>
            <dt className="text-[0.9375rem] font-medium text-fg">DTLS-SRTP</dt>
            <dd className="mt-1">
              Standard WebRTC transport encryption. Protects each hop. The server terminates it.
            </dd>
          </div>
          <div>
            <dt className="text-[0.9375rem] font-medium text-fg">AES-GCM frame encryption</dt>
            <dd className="mt-1">
              Applied in your browser or on your phone, before the media ever reaches the
              network. The server never holds this key.
            </dd>
          </div>
        </dl>
      </Section>

      <Section title="What else is in the box">
        <dl className="space-y-4">
          <div>
            <dt className="text-[0.9375rem] font-medium text-fg">No accounts</dt>
            <dd className="mt-1">
              No sign-up, no directory, no profile. A meeting is a link. That is the whole model.
            </dd>
          </div>
          <div>
            <dt className="text-[0.9375rem] font-medium text-fg">Nothing stored</dt>
            <dd className="mt-1">
              No recordings, no transcripts, no chat history. Messages live in memory and are
              gone when the tab closes.
            </dd>
          </div>
          <div>
            <dt className="text-[0.9375rem] font-medium text-fg">Safety number</dt>
            <dd className="mt-1">
              A short fingerprint of the room key. Read it aloud to confirm two people opened
              the same invitation.
            </dd>
          </div>
          <div>
            <dt className="text-[0.9375rem] font-medium text-fg">Ask to join</dt>
            <dd className="mt-1">
              A lobby, so someone already in the meeting decides who comes in — and that
              authority disappears when they leave.
            </dd>
          </div>
          <div>
            <dt className="text-[0.9375rem] font-medium text-fg">Works on locked-down networks</dt>
            <dd className="mt-1">
              If a firewall blocks direct media, the call falls back to a TLS relay on port 443.
              The relay carries ciphertext too.
            </dd>
          </div>
          <div>
            <dt className="text-[0.9375rem] font-medium text-fg">iOS and Android</dt>
            <dd className="mt-1">
              Native apps using the platform frame cryptor, not a web view. Meeting links open
              straight into them.
            </dd>
          </div>
        </dl>
      </Section>

      <Section title="What this protects, and what it does not">
        <p>
          Security writing tends to list only the wins. These are the limits, in plain terms,
          because a tool you misjudge is more dangerous than one you understand.
        </p>
        <ul className="mt-4 space-y-3">
          <Claim holds>
            <strong className="font-medium text-fg">
              Content is unreadable by the server.
            </strong>{' '}
            Audio, video, screen share, and chat are encrypted before they leave your device.
          </Claim>
          <Claim holds>
            <strong className="font-medium text-fg">
              A seized or subpoenaed server yields ciphertext.
            </strong>{' '}
            There is no key on it to hand over, and nothing recorded to seize.
          </Claim>
          <Claim holds>
            <strong className="font-medium text-fg">No downgrade path.</strong> If a browser
            cannot encrypt end to end, NME Talk refuses to connect rather than quietly joining
            in the clear.
          </Claim>
          <Claim holds={false}>
            <strong className="font-medium text-fg">Metadata is visible.</strong> The server
            sees that a meeting exists, when, for how long, and how much bandwidth each
            participant used.
          </Claim>
          <Claim holds={false}>
            <strong className="font-medium text-fg">Anyone with the link can join.</strong> The
            link is the secret. Send it the way you would send a password.
          </Claim>
          <Claim holds={false}>
            <strong className="font-medium text-fg">Participants can record.</strong> Everyone
            in a call necessarily holds decrypted media. No software can prevent a screen
            recorder, let alone a second phone pointed at the screen.
          </Claim>
        </ul>
      </Section>

      <Section title="Contact">
        <p>
          Questions, problems, or an abuse report:{' '}
          <a className="text-accent underline" href="mailto:support@nmetalk.com">
            support@nmetalk.com
          </a>
          .
        </p>
      </Section>

      <Section title="Start a meeting">
        <p>
          No account, no install, nothing to configure.{' '}
          <a className="text-accent underline" href="/" onClick={routeOnClick('/')}>
            Start one now
          </a>
          , or read the{' '}
          <a className="text-accent underline" href="/privacy" onClick={routeOnClick('/privacy')}>
            privacy policy
          </a>{' '}
          first.
        </p>
      </Section>
    </PageLayout>
  );
}
