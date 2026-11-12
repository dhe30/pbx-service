import { useContext } from "react";
import { SoftphoneContext } from "../contexts/softphone-state";

export function useSoftphone() {
    const context = useContext(SoftphoneContext);
    if (!context) 
        throw new Error("useSoftphone must be used inside SoftphoneProvider");
    return context;
}
