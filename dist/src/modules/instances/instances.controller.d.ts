import * as core from "express-serve-static-core";
declare class InstancesController {
    readonly router: core.Router;
    constructor();
    private routine;
    private create;
    private list;
    private getOneByName;
}
export default InstancesController;
