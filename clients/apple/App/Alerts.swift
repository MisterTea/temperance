import CoreLocation
import UserNotifications

/// Shows child alerts computed by the shared core as local notifications.
struct ChildNotifier: Notifier {
    func requestPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }
    func post(_ message: String) {
        let content = UNMutableNotificationContent()
        content.title = "Temperance"
        content.body = message
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
    func allowed() async -> Bool? {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        return status == .notDetermined ? nil : status == .authorized || status == .provisional
    }
}

/// Answers an admin's one-time location request with a single fix.
@MainActor final class LocationResponder: NSObject, CLLocationManagerDelegate, LocationSource {
    private let manager: CLLocationManager
    private var pending: CheckedContinuation<CLLocation?, Never>?

    init(manager: CLLocationManager = CLLocationManager()) {
        self.manager = manager
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    func requestPermission() { manager.requestWhenInUseAuthorization() }

    /// `nil` until the child has been asked.
    var allowed: Bool? {
        switch manager.authorizationStatus {
        case .notDetermined: nil
        case .denied, .restricted: false
        default: true
        }
    }

    /// Returns nil with a reason when no fix can be shared.
    func currentLocation() async -> (CLLocation?, String) {
        switch manager.authorizationStatus {
        case .denied, .restricted: return (nil, "location permission not granted")
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
            return (nil, "location permission not granted yet")
        default: break
        }
        if pending != nil { return (nil, "location request already in progress") }
        let fix = await withCheckedContinuation { continuation in
            pending = continuation
            manager.requestLocation()
        }
        return (fix, fix == nil ? "no location fix available" : "")
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let last = locations.last
        Task { @MainActor in finish(last) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in finish(nil) }
    }

    private func finish(_ location: CLLocation?) {
        pending?.resume(returning: location)
        pending = nil
    }
}
