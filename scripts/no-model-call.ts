// A model factory for a promise that no model call is made. Every model factory in the app is
// called only when a model call is about to happen, so calling this one fails the test, and no
// model client, real or stand-in, is ever built.
export const noModelCall = (): never => {
  throw new Error("No model call was expected here.");
};
