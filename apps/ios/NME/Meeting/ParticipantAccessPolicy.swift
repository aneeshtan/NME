struct ParticipantAccessPolicy: Equatable, Sendable {
    private(set) var blockedIdentities: Set<String> = []

    mutating func block(_ identity: String) {
        blockedIdentities.insert(identity)
    }

    func isBlocked(_ identity: String) -> Bool {
        blockedIdentities.contains(identity)
    }

    func acceptsData(from identity: String) -> Bool {
        !isBlocked(identity)
    }
}
