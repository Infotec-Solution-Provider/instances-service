import { QueryError, QueryResult } from "mysql2";
export type CustomQueryResult = {
    err: QueryError;
} | {
    result: QueryResult;
};
