#!/usr/bin/env swift

//  thesystem-keychain — Touch ID-protected keychain access
//
//  Usage:
//    thesystem-keychain set <service> <account> <value>
//    thesystem-keychain get <service> <account>
//    thesystem-keychain delete <service> <account>
//
//  Stores secrets in the Data Protection Keychain with biometric
//  (Touch ID / Apple Watch) gating via kSecAccessControlBiometryAny.
//  Falls back to device passcode if biometric is unavailable.
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

func makeAccessControl() -> SecAccessControl {
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        kCFAllocatorDefault,
        kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
        [.biometryAny],
        &error
    ) else {
        let msg = error?.takeRetainedValue().localizedDescription ?? "unknown"
        fail("SecAccessControlCreateWithFlags: \(msg)")
    }
    return access
}

// MARK: - Commands

func setSecret(service: String, account: String, value: String) {
    guard let data = value.data(using: .utf8) else {
        fail("could not encode value as UTF-8")
    }

    let access = makeAccessControl()

    // Delete any existing item first (update not supported with ACL change)
    let deleteQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecUseDataProtectionKeychain as String: true,
    ]
    SecItemDelete(deleteQuery as CFDictionary)

    let addQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecValueData as String: data,
        kSecAttrAccessControl as String: access,
        kSecUseDataProtectionKeychain as String: true,
    ]

    let status = SecItemAdd(addQuery as CFDictionary, nil)
    guard status == errSecSuccess else {
        fail("SecItemAdd failed: \(SecCopyErrorMessageString(status, nil) ?? "code \(status)" as CFString)")
    }
    fputs("ok\n", stderr)
}

func getSecret(service: String, account: String) {
    let context = LAContext()
    context.localizedReason = "thesystem needs your API key"

    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecReturnData as String: true,
        kSecUseAuthenticationContext as String: context,
        kSecUseDataProtectionKeychain as String: true,
    ]

    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)

    guard status == errSecSuccess, let data = result as? Data,
          let str = String(data: data, encoding: .utf8) else {
        if status == errSecItemNotFound {
            fail("not found: \(service)/\(account)")
        }
        if status == errSecAuthFailed || status == errSecUserCanceled {
            fail("authentication failed or cancelled")
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
        kSecUseDataProtectionKeychain as String: true,
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

    Stores secrets with Touch ID protection via Data Protection Keychain.

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
