"""OCP names that differ between the kernels this package runs on.

OCP 8 moved every NCollection instantiation into ``OCP.collections`` under a
name spelled from its template arguments (``TopTools_IndexedMapOfShape`` became
``IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher``); OCP 7.9 has them in the
module of the toolkit that typedefs them. The classes themselves are the same
and take the same calls, so code imports the name from here and runs on both.

Import collection types from this module, never from ``OCP.TopTools`` /
``OCP.TDF`` / ``OCP.collections`` directly. A name missing here on one kernel
is an ``ImportError`` at import, not a surprise mid-build.
"""

from __future__ import annotations

try:  # OCP 8
    from OCP.collections import (
        IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher as IndexedMapOfShape,
        List_TopoDS_Shape as ListOfShape,
        Sequence_TDF_Label as LabelSequence,
    )

    OCP_COLLECTIONS_MODULE = True
except ImportError:  # OCP 7.9
    from OCP.TDF import TDF_LabelSequence as LabelSequence
    from OCP.TopTools import (
        TopTools_IndexedMapOfShape as IndexedMapOfShape,
        TopTools_ListOfShape as ListOfShape,
    )

    OCP_COLLECTIONS_MODULE = False

def bnd_box_limits(box) -> tuple[float, float, float, float, float, float]:
    """``(xmin, ymin, zmin, xmax, ymax, zmax)`` of a non-void ``Bnd_Box``, gap included.

    What ``Bnd_Box.Get()`` returns on OCP 7.9. OCP 8 binds ``Get()`` to a struct
    pybind cannot convert (``Bnd_Box::Limits``), so read the corners, which both
    kernels return as points.
    """
    low, high = box.CornerMin(), box.CornerMax()
    return (low.X(), low.Y(), low.Z(), high.X(), high.Y(), high.Z())


__all__ = ["IndexedMapOfShape", "LabelSequence", "ListOfShape", "OCP_COLLECTIONS_MODULE", "bnd_box_limits"]
