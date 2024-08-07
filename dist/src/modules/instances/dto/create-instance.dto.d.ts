import { ServerDto } from "../../servers/dto/create-server.dto";
import "reflect-metadata";
export declare class CreateInstanceDto {
    name: string;
    server?: ServerDto;
    parameters?: Record<string, any>;
}
