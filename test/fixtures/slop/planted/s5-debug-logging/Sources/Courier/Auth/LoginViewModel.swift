import Foundation
import KeychainAccess

@MainActor
@Observable
final class LoginViewModel {
    var email = ""
    var password = ""
    var errorMessage: String?
    private(set) var user: User?

    private let api: APIClient
    private let keychain = Keychain(service: "com.example.courier")

    init(api: APIClient) {
        self.api = api
    }

    func signIn() async {
        struct Credentials: Encodable { let email: String; let password: String }
        do {
            let session: Session = try await api.post("/v1/sessions", body: Credentials(email: email, password: password))
            keychain["accessToken"] = session.accessToken
            user = session.user
            print(session.user.email)
            NSLog("Signed in with token %@", session.accessToken)
        } catch {
            errorMessage = "We couldn't sign you in. Check your email and password and try again."
        }
    }
}
