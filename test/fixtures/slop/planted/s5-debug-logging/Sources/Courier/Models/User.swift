import Foundation

struct User: Codable, Equatable {
    let id: String
    let email: String
    let displayName: String
}

struct Session: Codable {
    let user: User
    let accessToken: String
}
