# Publishing NME to the App Store and Google Play

Written in the order things will block you, not in the order the consoles
present them. The build is the easy part; two policy items and one export-law
form are what actually decide whether this ships.

---

## 1. What it costs

| | Cost | Notes |
|---|---|---|
| Apple Developer Program | **$99/year** | Required to ship anything, including TestFlight. |
| Google Play Console | **$25 once** | One-time registration fee. |
| Builds | **$0** | Build locally with Xcode and Android Studio. EAS Build is optional. |

No other paid service is required. The apps talk to the same self-hosted
control plane and SFU the web client already uses.

---

## 2. The two things most likely to get you rejected

### 2.1 Guideline 1.2 — user-generated content (Apple), and Play's UGC policy

**This is the real risk, and it deserves attention before you write a single
line of store copy.** Apple clarified in February 2026 that apps with anonymous
chat fall under Guideline 1.2, which demands four things:

1. A method for **filtering objectionable material**
2. A mechanism to **report** offensive content, with a response within 24 hours
3. The ability to **block abusive users**
4. **Published contact information**

Requirement 1 is impossible here, and not by oversight — end-to-end encryption
means no operator, including you, can inspect content. Do not attempt to claim
otherwise, and do not weaken encryption to satisfy a form.

The argument that works is that NME is *communication*, not a content platform.
FaceTime, Signal, and WhatsApp calls are all E2EE, all unfilterable, and all
approved, because content moves between people who deliberately exchanged an
invitation rather than being published to strangers. NME is closer to those
than to a random-chat app: there is no discovery, no directory, no matching —
you can only reach someone by sending them a link.

Put that argument in the review notes verbatim, and back it with the other
three requirements actually implemented:

- [ ] **Block**: let a participant hide and locally mute anyone in the meeting,
      and let a meeting's creator remove someone outright.
- [ ] **Report**: a per-participant "Report" action that opens a prefilled
      message to your support address with the room ID and timestamp, and
      nothing else — there is no content to attach.
- [ ] **Contact**: a support email and URL, reachable from inside the app and
      listed on the store page.
- [ ] A published policy stating what you do on a report (you can act on
      identifiers and revoke rooms; you cannot read content).

> Status: **not yet implemented.** The mobile app currently has no block or
> report action. Submitting before adding them is very likely to draw a 1.2
> rejection.

### 2.2 Guideline 4.2 — minimum functionality

This is what rejects thin WebView wrappers of a website. It does not apply
here, and the reason is worth knowing: the mobile app is not a wrapper. It uses
native WebRTC via LiveKit's SDK, the platform's own frame cryptor, real camera
and microphone pipelines, Universal Links, and background audio. There is no
WebView in the app at all.

Google Play's equivalent policy behaves the same way.

---

## 3. Export compliance — do not get this one wrong

NME implements AES-GCM end-to-end encryption of user content. That is **not**
covered by the common exemptions, which are for apps that only use HTTPS or
only call the operating system's own crypto for authentication.

`app.config.ts` therefore declares `ITSAppUsesNonExemptEncryption: true`. Do not
flip that to `false` to skip the questionnaire — it is a declaration to a
government agency, not a checkbox.

What is required, for the US (BIS), because you distribute from the US stores:

1. Self-classify under License Exception ENC, mass-market provisions
   (§740.17(b)(1)). Standard published algorithms used for their normal purpose
   is exactly the case this covers.
2. Email an **annual self-classification report** to BIS and the NSA, listing
   the product. Due by 1 February each year for the previous year.
3. Apple will ask for a CCATS or an exemption basis at submission. The
   self-classification above is the basis; you do not need a CCATS for
   mass-market symmetric crypto of this kind.

France additionally requires a declaration for apps distributed there; Apple
prompts for this during submission.

**This is a legal matter and the above is a summary of the usual path, not
legal advice.** If NME will be distributed commercially or at scale, have
somebody qualified confirm the classification.

---

## 4. Filling in the app-link documents

Meeting links only open the app once the domain vouches for it. Two files ship
with placeholders in `apps/web/public/.well-known/` and must be completed —
see [app-links.md](./app-links.md) for the exact values and the two mistakes
that cost people days.

Verify after deploying, before you submit:

```bash
curl -sI https://nmetalk.com/.well-known/apple-app-site-association | grep -i content-type
curl -s  https://nmetalk.com/.well-known/assetlinks.json | python3 -m json.tool
```

---

## 5. Building

Everything below runs locally and costs nothing.

```bash
# Generate the native projects (they are gitignored and regenerated on demand)
npm run prebuild -w @nme/mobile

# iOS — needs Xcode and CocoaPods
sudo gem install cocoapods       # if `pod` is missing
npm run ios -w @nme/mobile

# Android — needs a JDK 17+ and the Android SDK
npm run android -w @nme/mobile
```

Point a build at a different deployment with `NME_HOST`:

```bash
NME_HOST=meet.example.com npm run prebuild -w @nme/mobile
```

For release builds, archive from Xcode (Product → Archive) and generate a
signed AAB from Android Studio (Build → Generate Signed Bundle). EAS Build is
an alternative if you would rather not keep a Mac in the loop, but it is not
required and its free tier is limited.

---

## 6. Google Play: the 12-testers rule

If your Play developer account is **personal** and was created after
13 November 2023, you cannot publish to production until you have run a
**closed test with at least 12 testers opted in for 14 consecutive days**.

Details that catch people out:

- Internal testing does not count. It must be a *closed* test.
- "Opted in" means each tester accepted the invite and installed the app under
  the matching Google account. Adding twelve email addresses does nothing.
- Dropping below twelve at any point can reset the fourteen-day clock.
- Organisation accounts, and personal accounts older than that date, are exempt.

Plan for this taking three weeks before you can even apply for production
access. Apple has no equivalent requirement.

---

## 7. Store listing content

### Privacy labels (Apple) and Data Safety (Google)

NME's answers are unusually short, and all of them are true:

| Question | Answer |
|---|---|
| Data collected | **None.** |
| Data linked to the user | None. |
| Tracking | None. No analytics SDK, no advertising identifier. |
| Data shared with third parties | None. |
| Data encrypted in transit | Yes — TLS, plus AES-GCM end-to-end on media and messages. |
| Can users request deletion | There is nothing stored to delete. |

Two things to be precise about rather than glib:

- The **display name** a participant types is transmitted to other participants
  and passes through the server in the join token. It is not stored, but it is
  not "collected nothing" either — declare it as user content that is not
  linked to identity and not retained.
- The server's operational logs see IP addresses, as any server does. Say so in
  the privacy policy.

### Age rating

Expect **17+ / Mature**. Live video between people cannot be rated lower, and
under-rating it invites a rejection you cannot argue with. Answer "yes" to
unrestricted web/user content in the questionnaire.

### Review notes — write these, they matter

Reviewers cannot test this app without a link. Give them one:

```
NME has no accounts and no sign-in. To test:

1. Open the app and tap "New meeting".
2. Tap "Share link" and open the link on a second device, or in a
   browser at https://nmetalk.com
3. Both participants are now in an end-to-end encrypted meeting.

Regarding Guideline 1.2: NME is a communication tool, not a content
platform. There is no discovery, directory, or matching — a meeting can
only be joined by someone who was sent its link, in the same way as an
encrypted call. Media and messages are end-to-end encrypted, so no
operator, including us, is technically able to inspect content. Reporting,
blocking, and contact information are provided in-app.
```

### Screenshots

Required sizes: 6.9" and 6.5" iPhone for Apple; phone and 7"/10" tablet for
Play. Take them from a real two-participant call — a grid with one tile looks
like a broken app, and reviewers notice.

---

## 8. Pre-submission checklist

- [ ] `apple-app-site-association` filled in with the real Team ID and serving
      as `application/json`
- [ ] `assetlinks.json` filled in with the **Play App Signing** fingerprint,
      not the upload key
- [ ] Block, report, and contact affordances implemented (§2.1)
- [ ] Privacy policy published and linked from both store listings
- [ ] Support email and URL live
- [ ] Export self-classification filed; `ITSAppUsesNonExemptEncryption` left as
      `true`
- [ ] Age rating set to 17+ / Mature
- [ ] Review notes pasted in, including the 1.2 paragraph
- [ ] A real two-device call completed on both platforms, and a call between a
      phone and a browser — see the interop note in the README
