#!/usr/bin/env swift

//  thesystem-keychain — Touch ID-gated keychain access
//
//  Usage:
//    thesystem-keychain set <service> <account> <value>
//    thesystem-keychain get <service> <account>
//    thesystem-keychain delete <service> <account>
//
//  Reads require Touch ID verification via LAContext before returning
//  the secret from the standard macOS Keychain. Writes store to the
//  standard Keychain (same as `security add-generic-password`).
//
//  Build:
//    swiftc -O -o dist/thesystem-keychain swift/thesystem-keychain.swift \
//      -framework Security -framework LocalAuthentication

import Foundation
import Security
import LocalAuthentication

// MARK: - Helpers

func fail(_ message: String) -> Never {
    fputs("error: \(message)\n", stderr)
    exit(1)
}

/// Prompt for Touch ID / Apple Watch / passcode. Blocks until resolved.
func requireBiometric(reason: String) {
    let context = LAContext()
    var error: NSError?

    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
        fail("biometric unavailable: \(error?.localizedDescription ?? "unknown")")
    }

    let semaphore = DispatchSemaphore(value: 0)
    var authError: Error?

    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, err in
        if !success {
            authError = err
        }
        semaphore.signal()
    }

    semaphore.wait()

    if let err = authError {
        fail("authentication failed: \(err.localizedDescription)")
    }
}

// MARK: - Keychain Operations (standard file-based keychain)

func setSecret(service: String, account: String, value: String) {
    guard let data = value.data(using: .utf8) else {
        fail("could not encode value as UTF-8")
    }

    // Delete any existing item first
    let deleteQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
    ]
    SecItemDelete(deleteQuery as CFDictionary)

    let addQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecValueData as String: data,
    ]

    let status = SecItemAdd(addQuery as CFDictionary, nil)
    guard status == errSecSuccess else {
        fail("SecItemAdd failed: \(SecCopyErrorMessageString(status, nil) ?? "code \(status)" as CFString)")
    }
    fputs("ok\n", stderr)
}

func getSecret(service: String, account: String) {
    // Require biometric BEFORE reading the secret
    requireBiometric(reason: "thesystem needs access to your API key")

    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecReturnData as String: true,
    ]

    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)

    guard status == errSecSuccess, let data = result as? Data,
          let str = String(data: data, encoding: .utf8) else {
        if status == errSecItemNotFound {
            fail("not found: \(service)/\(account)")
        }
        fail("SecItemCopyMatching failed: \(SecCopyErrorMessageString(status, nil) ?? "code \(status)" as CFString)")
    }

    // Write secret to stdout (no newline — matches `security -w` behavior)
    print(str, terminator: "")
}

func deleteSecret(service: String, account: String) {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
    ]

    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
        fail("SecItemDelete failed: \(SecCopyErrorMessageString(status, nil) ?? "code \(status)" as CFString)")
    }
    fputs("ok\n", stderr)
}

// MARK: - Main

let args = CommandLine.arguments
guard args.count >= 2 else {
    fputs("""
    Usage:
      thesystem-keychain set <service> <account> <value>
      thesystem-keychain get <service> <account>
      thesystem-keychain delete <service> <account>

    Reads require Touch ID verification before returning secrets.

    """, stderr)
    exit(1)
}

let command = args[1]

switch command {
case "set":
    guard args.count == 5 else { fail("usage: set <service> <account> <value>") }
    setSecret(service: args[2], account: args[3], value: args[4])

case "get":
    guard args.count == 4 else { fail("usage: get <service> <account>") }
    getSecret(service: args[2], account: args[3])

case "delete":
    guard args.count == 4 else { fail("usage: delete <service> <account>") }
    deleteSecret(service: args[2], account: args[3])

default:
    fail("unknown command: \(command)")
}
