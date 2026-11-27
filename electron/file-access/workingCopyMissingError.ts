export class WorkingCopyMissingError extends Error {
    constructor(message = 'Working copy is no longer available') {
        super(message);
        this.name = 'WorkingCopyMissingError';
        Object.assign(this, {code: 'WORKING_COPY_MISSING'});
    }
}
