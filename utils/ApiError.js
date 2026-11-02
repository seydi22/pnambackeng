// backend/utils/ApiError.js

class ApiError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = true; // Pour différencier les erreurs de programmation des erreurs opérationnelles
    }
}

module.exports = ApiError;