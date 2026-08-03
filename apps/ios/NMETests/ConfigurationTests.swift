import XCTest
@testable import NME

final class ConfigurationTests: XCTestCase {
    func testBuiltApplicationMetadataIsProductionScoped() throws {
        let info = Bundle.main.infoDictionary ?? [:]

        XCTAssertEqual(Bundle.main.bundleIdentifier, "com.ctrlaltl.nme")
        XCTAssertEqual(info["CFBundleDisplayName"] as? String, "NME Talk")
        XCTAssertEqual(info["ITSAppUsesNonExemptEncryption"] as? Bool, true)
        XCTAssertEqual(info["UIBackgroundModes"] as? [String], ["audio"])
        let builtInfo = try propertyList(
            at: Bundle.main.bundleURL.appendingPathComponent("Info.plist")
        )
        XCTAssertEqual(
            builtInfo["UISupportedInterfaceOrientations~ipad"] as? [String],
            [
                "UIInterfaceOrientationPortrait",
                "UIInterfaceOrientationPortraitUpsideDown",
                "UIInterfaceOrientationLandscapeLeft",
                "UIInterfaceOrientationLandscapeRight",
            ]
        )
        XCTAssertEqual(
            (info["NSAppTransportSecurity"] as? [String: Any])?["NSAllowsArbitraryLoads"] as? Bool,
            false
        )

        let camera = try XCTUnwrap(info["NSCameraUsageDescription"] as? String)
        let microphone = try XCTUnwrap(info["NSMicrophoneUsageDescription"] as? String)
        XCTAssertTrue(camera.localizedCaseInsensitiveContains("encrypted"))
        XCTAssertTrue(microphone.localizedCaseInsensitiveContains("encrypted"))

        for key in ["NMEOrigin", "NMEPrivacyURL", "NMESupportURL"] {
            let value = try XCTUnwrap(info[key] as? String)
            XCTAssertEqual(URL(string: value)?.scheme, "https", key)
        }

        let URLTypes = try XCTUnwrap(info["CFBundleURLTypes"] as? [[String: Any]])
        let schemes = URLTypes.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
        XCTAssertEqual(schemes, ["nmetalk"])
    }

    func testEntitlementsAndAssociationFileUseShippingApplicationIdentifier() throws {
        let entitlements = try propertyList(at: bundledResource("NME", extension: "entitlements"))
        XCTAssertEqual(
            entitlements["com.apple.developer.associated-domains"] as? [String],
            ["applinks:nmetalk.com"]
        )

        let associationURL = try bundledResource("apple-app-site-association")
        let data = try Data(contentsOf: associationURL)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let applinks = try XCTUnwrap(object["applinks"] as? [String: Any])
        let details = try XCTUnwrap(applinks["details"] as? [[String: Any]])
        XCTAssertEqual(details.first?["appIDs"] as? [String], ["WC955H63L3.com.ctrlaltl.nme"])
    }

    func testBuiltAssetCatalogContainsPrimaryIconAndLaunchColor() throws {
        let info = Bundle.main.infoDictionary ?? [:]
        let icons = try XCTUnwrap(info["CFBundleIcons"] as? [String: Any])
        let primaryIcon = try XCTUnwrap(icons["CFBundlePrimaryIcon"] as? [String: Any])
        XCTAssertEqual(primaryIcon["CFBundleIconName"] as? String, "AppIcon")
        XCTAssertEqual(
            primaryIcon["CFBundleIconFiles"] as? [String],
            ["AppIcon60x60"]
        )
        XCTAssertEqual(
            (info["UILaunchScreen"] as? [String: Any])?["UIColorName"] as? String,
            "LaunchBackground"
        )
        XCTAssertNotNil(Bundle.main.url(forResource: "Assets", withExtension: "car"))
    }

    func testXcodeGenSelectsTheAppIconCatalog() throws {
        let project = try String(
            contentsOf: bundledResource("project", extension: "yml"),
            encoding: .utf8
        )
        XCTAssertTrue(project.contains("ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon"))
    }

    func testBuiltAppIncludesUserDefaultsPrivacyManifestWithoutTracking() throws {
        let manifestURL = try XCTUnwrap(
            Bundle.main.url(forResource: "PrivacyInfo", withExtension: "xcprivacy")
        )
        let manifest = try propertyList(at: manifestURL)

        XCTAssertEqual(manifest["NSPrivacyTracking"] as? Bool, false)
        XCTAssertTrue(
            (manifest["NSPrivacyCollectedDataTypes"] as? [[String: Any]])?.isEmpty == true
        )
        let accessed = try XCTUnwrap(
            manifest["NSPrivacyAccessedAPITypes"] as? [[String: Any]]
        )
        let userDefaults = try XCTUnwrap(accessed.first(where: {
            $0["NSPrivacyAccessedAPIType"] as? String == "NSPrivacyAccessedAPICategoryUserDefaults"
        }))
        XCTAssertEqual(userDefaults["NSPrivacyAccessedAPITypeReasons"] as? [String], ["CA92.1"])
    }

    private func bundledResource(_ name: String, extension: String? = nil) throws -> URL {
        let fileName = `extension`.map { "\(name).\($0)" } ?? name
        let URL = Bundle(for: ConfigurationTests.self).bundleURL.appendingPathComponent(fileName)
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: URL.path),
            "Missing bundled test fixture: \(fileName)"
        )
        return URL
    }

    private func propertyList(at URL: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: URL)
        return try XCTUnwrap(
            PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        )
    }
}
