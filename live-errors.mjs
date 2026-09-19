// Elicitation must depend on a stable error code, never words in an error message.
export function homeRequestError(code, message) {
  return Object.assign(new Error(message), { code });
}
