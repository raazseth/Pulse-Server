export class AppError extends Error {
    public type: number;
    public status: number;

    constructor(message: string, type: number, status: number) {
        super(message);
        this.type = type;
        this.status = status;
    }
}
