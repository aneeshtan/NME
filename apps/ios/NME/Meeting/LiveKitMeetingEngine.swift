import Foundation
import LiveKit

final class LiveKitMeetingEngine: NSObject, MeetingEngine, RoomDelegate, @unchecked Sendable {
    @MainActor private var eventHandler: (@MainActor @Sendable (MeetingEngineEvent) -> Void)?
    @MainActor private var activeRoom: Room?
    @MainActor private var videoTracks: [String: VideoTrack] = [:]
    @MainActor private var blockedIdentities: Set<String> = []
    @MainActor private var localFallbackIdentity = "local"
    @MainActor private let audioLifecycle: AudioLifecycle

    @MainActor
    override init() {
        audioLifecycle = AudioLifecycle()
        super.init()
    }

    @MainActor
    func setEventHandler(
        _ handler: (@MainActor @Sendable (MeetingEngineEvent) -> Void)?
    ) {
        eventHandler = handler
    }

    @MainActor
    func connect(_ request: MeetingConnectionRequest) async throws {
        await tearDownActiveRoom()

        let roomOptions = MediaEncryptionConfiguration.makeRoomOptions(
            identity: request.roomIdentity,
            videoCodec: request.configuration.videoCodec
        )
        let room = Room(
            delegate: self,
            connectOptions: LiveKitConnectionConfiguration.makeConnectOptions(for: request),
            roomOptions: roomOptions
        )
        localFallbackIdentity = request.credentials.identity
        blockedIdentities.removeAll()
        activeRoom = room
        audioLifecycle.start { [weak self] event in
            guard event == .mediaServicesReset else { return }
            self?.rebuildParticipants()
        }

        do {
            try await room.connect(
                url: request.credentials.url,
                token: request.credentials.token
            )
        } catch {
            await tearDown(room)
            throw LiveKitErrorClassifier.connectionError(error)
        }

        var microphoneEnabled = false
        if request.microphoneEnabled {
            do {
                try await room.localParticipant.setMicrophone(enabled: true)
                microphoneEnabled = true
            } catch {
                microphoneEnabled = false
            }
        }

        var cameraEnabled = false
        if request.cameraEnabled {
            do {
                try await room.localParticipant.setCamera(enabled: true)
                cameraEnabled = true
            } catch {
                cameraEnabled = false
            }
        }

        guard activeRoom === room else { return }
        eventHandler?(.localMedia(
            microphoneEnabled: microphoneEnabled,
            cameraEnabled: cameraEnabled
        ))
        rebuildParticipants()
    }

    @MainActor
    func disconnect() async {
        await tearDownActiveRoom()
    }

    @MainActor
    func setMicrophone(enabled: Bool) async throws {
        guard let room = activeRoom else { throw MeetingEngineError.connection }
        do {
            try await room.localParticipant.setMicrophone(enabled: enabled)
        } catch {
            throw LiveKitErrorClassifier.mediaError(error, operation: .microphone)
        }
        eventHandler?(.localMedia(
            microphoneEnabled: enabled,
            cameraEnabled: localCameraEnabled(in: room)
        ))
        rebuildParticipants()
    }

    @MainActor
    func setCamera(enabled: Bool) async throws {
        guard let room = activeRoom else { throw MeetingEngineError.connection }
        do {
            try await room.localParticipant.setCamera(enabled: enabled)
        } catch {
            throw LiveKitErrorClassifier.mediaError(error, operation: .camera)
        }
        eventHandler?(.localMedia(
            microphoneEnabled: localMicrophoneEnabled(in: room),
            cameraEnabled: enabled
        ))
        rebuildParticipants()
    }

    @MainActor
    func flipCamera() async throws {
        guard let room = activeRoom,
              let publication = room.localParticipant.trackPublications.values
              .first(where: { $0.source == .camera }),
              let track = publication.track as? LocalVideoTrack,
              let capturer = track.capturer as? CameraCapturer
        else {
            throw MeetingEngineError.connection
        }

        do {
            try await capturer.switchCameraPosition()
        } catch {
            throw LiveKitErrorClassifier.mediaError(error, operation: .camera)
        }
    }

    @MainActor
    func publishData(_ data: Data) async throws {
        guard let room = activeRoom else { throw MeetingEngineError.connection }
        do {
            try await room.localParticipant.publish(
                data: data,
                options: DataPublishOptions(topic: "nme-chat", reliable: true)
            )
        } catch {
            throw MeetingEngineError.connection
        }
    }

    @MainActor
    func blockParticipant(identity: String) async {
        guard let room = activeRoom,
              let participant = room.remoteParticipants.values.first(where: {
                  $0.identity?.stringValue == identity
              })
        else { return }

        blockedIdentities.insert(identity)
        for publication in participant.trackPublications.values {
            guard let remotePublication = publication as? RemoteTrackPublication else { continue }
            try? await remotePublication.set(subscribed: false)
        }
        rebuildParticipants()
    }

    @MainActor
    func videoTrack(for identifier: String) -> VideoTrack? {
        videoTracks[identifier]
    }

    @MainActor
    private func tearDownActiveRoom() async {
        guard let room = activeRoom else {
            audioLifecycle.stop()
            videoTracks.removeAll()
            blockedIdentities.removeAll()
            return
        }
        await tearDown(room)
    }

    @MainActor
    private func tearDown(_ room: Room) async {
        if activeRoom === room {
            activeRoom = nil
        }
        room.remove(delegate: self)
        audioLifecycle.stop()
        videoTracks.removeAll()
        blockedIdentities.removeAll()
        await room.disconnect()
    }

    @MainActor
    private func rebuildParticipants() {
        guard let room = activeRoom else { return }
        videoTracks.removeAll(keepingCapacity: true)

        var snapshots = [snapshot(for: room.localParticipant, isLocal: true)]
        snapshots.append(contentsOf: room.remoteParticipants.values.compactMap {
            guard let identity = $0.identity?.stringValue,
                  !blockedIdentities.contains(identity)
            else { return nil }
            return snapshot(for: $0, isLocal: false)
        })
        snapshots.sort {
            if $0.isLocal != $1.isLocal { return $0.isLocal }
            return $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
        eventHandler?(.participants(snapshots))
    }

    @MainActor
    private func snapshot(
        for participant: Participant,
        isLocal: Bool
    ) -> ParticipantSnapshot {
        let publications = Array(participant.trackPublications.values)
        let microphone = publications.first { $0.source == .microphone }
        let camera = publications.first { $0.source == .camera }
        let cameraTrack = camera?.track as? VideoTrack
        let cameraIsEnabled = cameraTrack != nil && camera?.isMuted == false
        let trackID = cameraIsEnabled ? camera?.sid.stringValue : nil

        if let trackID, let cameraTrack {
            videoTracks[trackID] = cameraTrack
        }

        let identity = participant.identity?.stringValue
            ?? participant.sid?.stringValue
            ?? (isLocal ? localFallbackIdentity : UUID().uuidString)
        let trimmedName = participant.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayName = if let trimmedName, !trimmedName.isEmpty {
            trimmedName
        } else {
            identity
        }

        return ParticipantSnapshot(
            identity: identity,
            displayName: displayName,
            isLocal: isLocal,
            isSpeaking: participant.isSpeaking,
            isMicrophoneMuted: microphone == nil || microphone?.isMuted == true,
            isCameraEnabled: cameraIsEnabled,
            videoTrackID: trackID
        )
    }

    @MainActor
    private func localMicrophoneEnabled(in room: Room) -> Bool {
        room.localParticipant.trackPublications.values.contains {
            $0.source == .microphone && $0.track != nil && !$0.isMuted
        }
    }

    @MainActor
    private func localCameraEnabled(in room: Room) -> Bool {
        room.localParticipant.trackPublications.values.contains {
            $0.source == .camera && $0.track != nil && !$0.isMuted
        }
    }

    @MainActor
    private func handleRoomEvent(
        from room: Room,
        _ event: MeetingEngineEvent
    ) {
        guard activeRoom === room else { return }
        eventHandler?(event)
    }

    @MainActor
    private func handleParticipantChange(from room: Room) {
        guard activeRoom === room else { return }
        rebuildParticipants()
    }

    nonisolated func room(_ room: Room, didStartReconnectWithMode _: ReconnectMode) {
        Task { @MainActor [weak self] in
            self?.handleRoomEvent(from: room, .reconnecting)
        }
    }

    nonisolated func room(_ room: Room, didCompleteReconnectWithMode _: ReconnectMode) {
        Task { @MainActor [weak self] in
            self?.handleRoomEvent(from: room, .reconnected)
            self?.handleParticipantChange(from: room)
        }
    }

    nonisolated func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        Task { @MainActor [weak self] in
            let mapped = error.map { LiveKitErrorClassifier.connectionError($0.type) }
            self?.handleRoomEvent(from: room, .disconnected(mapped))
        }
    }

    nonisolated func room(_: Room, didFailToConnectWithError _: LiveKitError?) {
        // The throwing connect call owns initial failure handling and relay retry.
    }

    nonisolated func room(_ room: Room, participantDidConnect _: RemoteParticipant) {
        participantChanged(in: room)
    }

    nonisolated func room(_ room: Room, participantDidDisconnect _: RemoteParticipant) {
        participantChanged(in: room)
    }

    nonisolated func room(_ room: Room, didUpdateSpeakingParticipants _: [Participant]) {
        participantChanged(in: room)
    }

    nonisolated func room(_ room: Room, participant _: Participant, didUpdateName _: String) {
        participantChanged(in: room)
    }

    nonisolated func room(
        _ room: Room,
        participant _: LocalParticipant,
        didPublishTrack _: LocalTrackPublication
    ) {
        participantChanged(in: room)
    }

    nonisolated func room(
        _ room: Room,
        participant _: RemoteParticipant,
        didPublishTrack _: RemoteTrackPublication
    ) {
        participantChanged(in: room)
    }

    nonisolated func room(
        _ room: Room,
        participant _: LocalParticipant,
        didUnpublishTrack _: LocalTrackPublication
    ) {
        participantChanged(in: room)
    }

    nonisolated func room(
        _ room: Room,
        participant _: RemoteParticipant,
        didUnpublishTrack _: RemoteTrackPublication
    ) {
        participantChanged(in: room)
    }

    nonisolated func room(
        _ room: Room,
        participant _: RemoteParticipant,
        didSubscribeTrack _: RemoteTrackPublication
    ) {
        participantChanged(in: room)
    }

    nonisolated func room(
        _ room: Room,
        participant _: RemoteParticipant,
        didUnsubscribeTrack _: RemoteTrackPublication
    ) {
        participantChanged(in: room)
    }

    nonisolated func room(
        _ room: Room,
        participant _: Participant,
        trackPublication _: TrackPublication,
        didUpdateIsMuted _: Bool
    ) {
        participantChanged(in: room)
    }

    nonisolated func room(
        _ room: Room,
        participant: RemoteParticipant?,
        didReceiveData data: Data,
        forTopic topic: String,
        encryptionType _: EncryptionType
    ) {
        guard topic == "nme-chat" else { return }
        Task { @MainActor [weak self] in
            self?.handleRoomEvent(
                from: room,
                .data(data, senderIdentity: participant?.identity?.stringValue)
            )
        }
    }

    nonisolated private func participantChanged(in room: Room) {
        Task { @MainActor [weak self] in
            self?.handleParticipantChange(from: room)
        }
    }
}
