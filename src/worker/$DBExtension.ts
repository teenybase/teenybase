import {HttpRoute} from "../types/route";
import {$Database} from "./$Database";

export abstract class $DBExtension {
    constructor(readonly db: $Database) {
    }

    setup?(version: number): Promise<void>

    routes: HttpRoute[] = []
}
