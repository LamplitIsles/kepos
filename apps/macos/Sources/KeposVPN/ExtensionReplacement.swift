/// The system checks signing teams before asking about an existing extension.
/// Only replace the provider named by the current activation request.
func mayReplaceExtension(expected: String?, request: String, existing: String, incoming: String) -> Bool {
    guard let expected, !expected.isEmpty else { return false }
    return request == expected && existing == expected && incoming == expected
}
