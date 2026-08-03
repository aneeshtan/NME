import LiveKit

enum LiveKitWireContract {
    static let chatTopic = "nme-chat"

    static var chatPublishOptions: DataPublishOptions {
        DataPublishOptions(topic: nil, reliable: true)
    }

    static func acceptsChat(topic: String) -> Bool {
        topic.isEmpty || topic == chatTopic
    }
}
