export class ActiveDownloads {
  private readonly controllersByDeleteToken = new Map<string, AbortController>();

  register(token: string, controller: AbortController): void {
    this.controllersByDeleteToken.set(token, controller);
  }

  abort(token: string): void {
    this.controllersByDeleteToken.get(token)?.abort();
  }

  clear(token: string, controller?: AbortController): void {
    if (controller && this.controllersByDeleteToken.get(token) !== controller) {
      return;
    }

    this.controllersByDeleteToken.delete(token);
  }
}
