# Native Jitsi Meet SDK integration

The Android and iOS Jitsi Meet SDKs can join the same recorded calls as the browser. The platform owns queueing, consent, room access, roles, and recording. The native app receives a short-lived Jitsi JWT from the call API; it never signs Jitsi tokens itself. The Jitsi server is self-hosted, so configure a public HTTPS domain with a certificate trusted by the device and a reachable Videobridge UDP port. A phone cannot use the Docker localhost hostname `meet.localtest.me` or the host's `127.0.0.1` as its server.

## Native customer sequence

1. The bank backend creates a one-time customer link using the existing integration or dashboard API. Deliver its code to the native app through an app link. The app removes the code from any visible URL and exchanges it with `POST /api/v2/sessions/customer`, body `{ "code": "..." }`. The response contains an access token and, for scoped integration sessions, `call_id`. Keep the access token and refresh cookie in secure app storage; never include either in analytics or logs.
2. Fetch `GET /api/v2/calls/current` or the scoped call ID with `Authorization: Bearer ACCESS_TOKEN`. Wait for the agent to claim and join the call. Obtain camera and microphone permission, show the recording disclosure, and submit `POST /api/v2/calls/:id/consent` with `{ "accepted": true, "version": "recording-v1" }`.
3. When the state is `ringing`, call `POST /api/v2/calls/:id/admission` with the same bearer token. A native customer cannot get admission before consent or recording capacity is reserved. The response is never cached:

   ```json
   {
     "success": true,
     "data": {
       "server_url": "https://meet.example.org",
       "domain": "meet.example.org",
       "room": "verifikasi-nasabah-12345678",
       "jwt": "ROOM_BOUND_SHORT_LIVED_TOKEN",
       "token_expires_at": "2026-10-05T09:05:00.000Z",
       "role": "customer"
     }
   }
   ```

4. Pass `server_url`, `room`, and `jwt` to the Jitsi Meet SDK. Start with audio and video enabled, with chat available. Show waiting/recording status from the call API, not from a local SDK recording indicator. Prosody confirms actual customer presence and triggers recording. The SDK's participant events do not authorize verification.
5. While the call is open, send `POST /api/v2/calls/:id/heartbeat` every 15 seconds and refresh call state on resume/reconnect. On a failed join or a reconnection after `token_expires_at`, fetch new admission while the call remains joinable. Once the call becomes terminal, close the SDK view and show the final outcome from `GET /api/v2/calls/:id`; `completing` means the recording/result is still being stored.

Native agents use the normal agent session or the one-time agent link exchange. They claim a queue item first, then request the same admission endpoint for that assigned call. Their response has `role: "agent"`; customers receive `role: "customer"`. The Prosody admission hook checks the live session and call on every join and assigns moderator privileges only to the agent. Do not override roles or create room URLs in the mobile app.

## Android (Kotlin)

Use a pinned version of the official Jitsi Meet SDK. After the API sequence above, map the admission response to conference options:

```kotlin
val options = JitsiMeetConferenceOptions.Builder()
    .setServerURL(URL(admission.server_url))
    .setRoom(admission.room)
    .setToken(admission.jwt)
    .setAudioMuted(false)
    .setVideoMuted(false)
    .setAudioOnly(false)
    .setWelcomePageEnabled(false)
    .setFeatureFlag("prejoinpage.enabled", false)
    .build()
JitsiMeetActivity.launch(this, options)
```

Listen for the SDK's conference terminated event to return to the bank's call-status screen, but fetch the persisted call state before displaying a result. If the customer intentionally cancels, use the authorized call cancellation API; merely closing the SDK does not set a verification outcome.

## iOS (Swift)

Add the official Jitsi Meet SDK to the bank app and provide `NSCameraUsageDescription` and `NSMicrophoneUsageDescription`. After admission:

```swift
let options = JitsiMeetConferenceOptions.fromBuilder { builder in
    builder.serverURL = URL(string: admission.serverUrl)
    builder.room = admission.room
    builder.token = admission.jwt
    builder.setAudioMuted(false)
    builder.setVideoMuted(false)
    builder.setFeatureFlag("prejoinpage.enabled", withBoolean: false)
}
meetView.join(options)
```

Use the view delegate to return to the bank's call-status screen when the conference ends. Fetch the current call state there. Dispose of the view when the screen closes.

## Deployment and device checks

Expose the application API and Jitsi web endpoint over real HTTPS on domains reachable from the device. Publish the Videobridge UDP media port (`10000/udp` in this Compose setup), configure its advertised public IP, and use TURN where required by restrictive networks. The local Docker certificate and loopback domain are for desktop smoke tests; physical devices need trusted TLS and routable DNS. Validate Android and iOS devices on Wi-Fi and cellular with an agent browser, including two-way audio/video, chat, reconnect, customer non-moderator role, Jibri recording, and playback of the stored object. Keep the Jitsi signing secret and internal Prosody/Jibri endpoints server-side.

SDK API references: [Android SDK](https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-android-sdk/), [iOS SDK](https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-ios-sdk/), and [official mobile samples](https://github.com/jitsi/jitsi-meet-sdk-samples).
