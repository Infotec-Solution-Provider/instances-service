"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const http_errors_1 = require("@rgranatodutra/http-errors");
class ClientPool {
    constructor(name, pool) {
        this.name = name;
        this.pool = pool;
    }
    async execute(query, parameters) {
        return new Promise(async (resolve, reject) => {
            const havePool = await new Promise((res) => {
                const validatePool = (tries = 0) => {
                    if (tries >= 3)
                        res(false);
                    else if (this.pool)
                        res(true);
                    else {
                        setTimeout(() => {
                            validatePool(tries++);
                        }, 1000);
                    }
                };
                validatePool();
            });
            if (!havePool) {
                reject(new http_errors_1.NotFoundError("failed to get client's pool"));
            }
            this.pool.query(query, parameters, (err, result) => {
                if (err) {
                    reject(new http_errors_1.BadRequestError("failed to execute query", err));
                }
                resolve({ result });
            });
        });
    }
}
exports.default = ClientPool;
//# sourceMappingURL=client-pool.entity.js.map