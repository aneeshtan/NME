/**
 * Reporting, and the contact details a store requires be reachable.
 *
 * App Store Guideline 1.2 asks for four things from any app carrying content
 * between users: filtering, reporting, blocking, and published contact
 * information. Three of them are here or in the room screen. The fourth —
 * filtering — is not possible and will not be faked: media and messages are
 * encrypted end to end, so no operator, including whoever runs this
 * deployment, can inspect them. Claiming otherwise on a review form would mean
 * either lying or building a backdoor.
 *
 * What a report can therefore carry is the room identifier and a timestamp,
 * which is enough to revoke a room and refuse it in future. It carries no
 * message text and no media, because none exists in readable form anywhere
 * outside the participants' own devices. That is the trade this app makes on
 * purpose, and the report body says so plainly rather than implying an
 * investigation that cannot happen.
 */
import { Linking } from 'react-native';
import Constants from 'expo-constants';

interface SupportConfig {
  supportEmail?: string;
  supportUrl?: string;
  privacyUrl?: string;
}

const extra = (Constants.expoConfig?.extra ?? {}) as SupportConfig;

export const SUPPORT_EMAIL = extra.supportEmail ?? 'support@nmetalk.com';
export const SUPPORT_URL = extra.supportUrl ?? 'https://nmetalk.com/support';
export const PRIVACY_URL = extra.privacyUrl ?? 'https://nmetalk.com/privacy';

/**
 * Opens a prefilled report. The user sends it themselves, from their own mail
 * client — this app has no server-side inbox and adding one would mean
 * collecting an email address from someone who currently gives us nothing.
 */
export async function reportParticipant(options: {
  roomId: string;
  displayName: string;
}): Promise<void> {
  const subject = `NME abuse report — room ${options.roomId}`;
  const body = [
    'Please describe what happened:',
    '',
    '',
    '---',
    `Reported participant (self-declared name): ${options.displayName}`,
    `Room: ${options.roomId}`,
    `Time: ${new Date().toISOString()}`,
    '',
    'Note: NME is end-to-end encrypted, so no recording, message, or media',
    'from this meeting exists in a readable form on the server. Reports are',
    'acted on by revoking the room and, where warranted, blocking the network',
    'address it was joined from.',
  ].join('\n');

  const url = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  // If no mail client is configured, the support page is the fallback rather
  // than a dead button.
  const canMail = await Linking.canOpenURL(url).catch(() => false);
  await Linking.openURL(canMail ? url : SUPPORT_URL);
}
