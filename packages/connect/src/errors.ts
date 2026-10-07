export class CorvenConnectError extends Error {
    constructor(
        message: string,
        /** HTTP status; 0 for network errors. */
        readonly status: number,
        /** Machine-readable reason from the API, e.g. "wrong_code", "step_up_required". */
        readonly code?: string,
    ) {
        super(message);
        this.name = 'CorvenConnectError';
    }
}

export class UserRejectedError extends CorvenConnectError {
    constructor() {
        super('You rejected the request.', 0, 'user_rejected');
        this.name = 'UserRejectedError';
    }
}
