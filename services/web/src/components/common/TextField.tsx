type TextFieldProps = {
    id: string;
    name: string;
    label: string;
    type?: string;
    placeholder?: string;
    autoComplete?: string;
    minLength?: number;
    maxLength?: number;
    testId?: string;
    required?: boolean;
    value?: string;
    onChange?: (value: string) => void;
};

export function TextField({
    id,
    name,
    label,
    type = "text",
    placeholder,
    autoComplete,
    minLength,
    maxLength,
    testId,
    required = false,
    value,
    onChange,
}: TextFieldProps) {
    return (
        <div className="flex flex-col gap-2">
            <label
                htmlFor={id}
                className="text-sm font-medium text-gray-700"
            >
                {label}
            </label>

            <input
                id={id}
                name={name}
                type={type}
                placeholder={placeholder}
                autoComplete={autoComplete}
                minLength={minLength}
                maxLength={maxLength}
                data-testid={testId}
                required={required}
                value={value}
                onChange={(event) => onChange?.(event.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
            />
        </div>
    );
}