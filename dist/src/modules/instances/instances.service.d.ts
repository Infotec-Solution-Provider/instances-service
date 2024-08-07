import { CreateInstanceDto } from "./dto/create-instance.dto";
declare class InstancesService {
    static create(data: CreateInstanceDto): Promise<CreateInstanceDto>;
    static findByName(name: string): Promise<CreateInstanceDto>;
    static list(): Promise<Array<CreateInstanceDto>>;
}
export default InstancesService;
