import Foundation

enum AppConfiguration {
    static let productName = "NME Talk"

    static let origin: URL = {
        let configured = Bundle.main.object(forInfoDictionaryKey: "NMEOrigin") as? String
        guard let configured, let url = URL(string: configured), url.scheme == "https" else {
            return URL(string: "https://nmetalk.com")!
        }
        return url
    }()

    static let privacyURL: URL = {
        configuredURL(for: "NMEPrivacyURL", fallback: "https://nmetalk.com/privacy")
    }()

    static let supportURL: URL = {
        configuredURL(for: "NMESupportURL", fallback: "https://nmetalk.com/how-it-works")
    }()

    private static func configuredURL(for key: String, fallback: String) -> URL {
        let configured = Bundle.main.object(forInfoDictionaryKey: key) as? String
        return configured.flatMap(URL.init(string:)) ?? URL(string: fallback)!
    }
}

