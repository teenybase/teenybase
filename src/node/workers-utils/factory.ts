import {UserError} from './errors'

type VariableNames = string
type DeprecatedNames = string
type ElementType<A> = A extends readonly (infer T)[] ? T : never;

/**
 * Create a function used to access an environment variable. It may return undefined if the variable is not set.
 *
 * This is not memoized to allow us to change the value at runtime, such as in testing.
 * A warning is shown if the client is using a deprecated version - but only once.
 * If a list of choices is provided, then the environment variable must be one of those given.
 */
export function getEnvironmentVariableFactory<
    Choices extends readonly string[],
>(options: {
    variableName: VariableNames;
    deprecatedName?: DeprecatedNames;
    choices?: Choices;
}): () => ElementType<Choices> | undefined;
/**
 * Create a function used to access an environment variable, with a default value if the variable is not set.
 *
 * This is not memoized to allow us to change the value at runtime, such as in testing.
 * A warning is shown if the client is using a deprecated version - but only once.
 * If a list of choices is provided, then the environment variable must be one of those given.
 */
export function getEnvironmentVariableFactory<
    Choices extends readonly string[],
>(options: {
    variableName: VariableNames;
    deprecatedName?: DeprecatedNames;
    defaultValue: () => ElementType<Choices>;
    readonly choices?: Choices;
}): () => ElementType<Choices>;

export function getEnvironmentVariableFactory<
    Choices extends readonly string[],
>({
      variableName,
      deprecatedName,
      choices,
      defaultValue,
  }: {
    variableName: VariableNames;
    deprecatedName?: DeprecatedNames;
    defaultValue?: () => ElementType<Choices>;
    readonly choices?: Choices;
}): () => ElementType<Choices> | undefined {
    let hasWarned = false;
    return () => {
        if (variableName in process.env) {
            return getProcessEnv(variableName, choices);
        }
        if (deprecatedName && deprecatedName in process.env) {
            if (!hasWarned) {
                hasWarned = true;
                // Ideally we'd use `logger.warn` here, but that creates a circular dependency that Vitest is unable to resolve
                // eslint-disable-next-line no-console
                console.warn(
                    `Using "${deprecatedName}" environment variable. This is deprecated. Please use "${variableName}", instead.`
                );
            }
            return getProcessEnv(deprecatedName, choices);
        }

        return defaultValue?.();
    };
}

/**
 * Get the value of an environment variable and check it is one of the choices.
 */
function getProcessEnv<Choices extends readonly string[]>(
    variableName: string,
    choices: Choices | undefined
): ElementType<Choices> | undefined {
    assertOneOf(choices, process.env[variableName]);
    return process.env[variableName];
}


/**
 * Assert `value` is one of a list of `choices`.
 */
function assertOneOf<Choices extends readonly string[]>(
    choices: Choices | undefined,
    value: string | undefined
): asserts value is ElementType<Choices> {
    if (Array.isArray(choices) && !choices.includes(value)) {
        throw new UserError(
            `Expected ${JSON.stringify(value)} to be one of ${JSON.stringify(choices)}`
        );
    }
}
