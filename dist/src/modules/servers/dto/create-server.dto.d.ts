import "reflect-metadata";
export declare class ServerDto {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
    client_name?: string;
}
export declare class CreateServerDto {
    server: ServerDto;
}
