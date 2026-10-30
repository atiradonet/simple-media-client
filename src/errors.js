// Thrown for problems the user can fix (bad input, bad config, expired token).
// main() prints the message alone, without a stack trace.
export class UserError extends Error {
  get name() {
    return 'UserError';
  }
}
